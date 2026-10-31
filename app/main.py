from __future__ import annotations

import asyncio
import hmac
import logging
import secrets
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.services.gemini import GeminiAnalysisError, analyze_discussion
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent / ".env")

DISCUSSION_TOPICS = (
    "Should schools teach financial literacy as a required subject?",
    "Does social media bring people closer together or push them apart?",
    "Should cities invest more in public transportation than private cars?",
    "How can communities reduce food waste?",
    "Should students have more choice in what they study?",
    "Can technology make education equally accessible to everyone?",
    "What is the best way to balance career ambitions and personal wellbeing?",
    "Should every city create more parks and public green spaces?",
    "How can young people make a positive difference in their communities?",
    "Is teamwork more important than individual achievement?",
)
MIN_PARTICIPANTS_TO_START = 2

app = FastAPI(title="GD Meet", description="A group discussion meeting prototype.")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


class Participant:
    def __init__(self, name: str, is_host: bool) -> None:
        self.id = uuid4().hex
        self.name = name
        self.is_host = is_host


class Room:
    def __init__(self, topic: str) -> None:
        self.id = uuid4().hex[:8]
        self.topic = topic
        self.host_token = secrets.token_urlsafe(24)
        self.connections: dict[WebSocket, Participant] = {}
        self.participants: set[str] = set()
        self.transcript: list[dict[str, str]] = []
        self.ai_analysis: dict[str, Any] | None = None
        self.ai_analysis_error: str | None = None
        self.started = False
        self.ended = False
        self.lock = asyncio.Lock()


rooms: dict[str, Room] = {}
logger = logging.getLogger(__name__)


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


async def broadcast(room: Room, event: dict[str, Any]) -> None:
    disconnected: list[WebSocket] = []
    for connection in tuple(room.connections):
        try:
            await connection.send_json(event)
        except (RuntimeError, WebSocketDisconnect):
            disconnected.append(connection)
    for connection in disconnected:
        room.connections.pop(connection, None)


def build_report(room: Room) -> dict[str, Any]:
    words_by_participant: dict[str, int] = defaultdict(int)
    turns_by_participant: dict[str, int] = defaultdict(int)
    for entry in room.transcript:
        if entry["speaker"] == "Agent":
            continue
        words_by_participant[entry["speaker"]] += len(entry["text"].split())
        turns_by_participant[entry["speaker"]] += 1

    scores = []
    for name in sorted(room.participants):
        turns = turns_by_participant[name]
        words = words_by_participant[name]
        score = min(100, 40 + min(turns * 10, 30) + min(words // 10, 30)) if turns else 0
        scores.append(
            {
                "participant": name,
                "participation_score": score,
                "contribution_turns": turns,
                "word_count": words,
            }
        )

    return {
        "room_id": room.id,
        "topic": room.topic,
        "transcript": room.transcript,
        "scores": scores,
        "score_note": (
            "Prototype score based only on contribution turns and word count; "
            "it does not assess discussion quality."
        ),
        "ai_analysis": room.ai_analysis,
        "ai_analysis_error": room.ai_analysis_error,
    }


@app.get("/")
async def home() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/join/{room_id}")
async def join_page(room_id: str) -> FileResponse:
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Meeting not found.")
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/rooms", status_code=201)
async def create_room() -> dict[str, str]:
    room = Room(topic=secrets.choice(DISCUSSION_TOPICS))
    rooms[room.id] = room
    return {"room_id": room.id, "host_token": room.host_token, "topic": room.topic}


@app.get("/api/rooms/{room_id}/report")
async def get_report(room_id: str) -> dict[str, Any]:
    room = rooms.get(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found.")
    if not room.ended:
        raise HTTPException(status_code=409, detail="The discussion has not ended.")
    return build_report(room)


@app.websocket("/ws/rooms/{room_id}")
async def room_socket(
    websocket: WebSocket,
    room_id: str,
    name: str = "Participant",
    host_token: str = "",
) -> None:
    room = rooms.get(room_id)
    if room is None:
        await websocket.close(code=4404, reason="Room not found")
        return
    if room.ended:
        await websocket.close(code=4409, reason="Discussion has ended")
        return

    is_host = bool(host_token) and hmac.compare_digest(host_token, room.host_token)
    participant_name = name.strip()[:40] or "Participant"
    await websocket.accept()
    async with room.lock:
        base_name = participant_name
        suffix = 2
        while participant_name in room.participants:
            participant_name = f"{base_name} ({suffix})"
            suffix += 1
        participant = Participant(participant_name, is_host)
        room.connections[websocket] = participant
        room.participants.add(participant.name)
        await websocket.send_json(
            {
                "type": "participants",
                "participants": [
                    {"id": other.id, "name": other.name}
                    for other in room.connections.values()
                    if other.id != participant.id
                ],
            }
        )
        await websocket.send_json(
            {
                "type": "room_info",
                "started": room.started,
                "topic": room.topic if room.started else None,
            }
        )
        await broadcast(
            room,
            {
                "type": "participant_joined",
                "id": participant.id,
                "name": participant.name,
            },
        )
        if not room.started and len(room.connections) >= MIN_PARTICIPANTS_TO_START:
            room.started = True
            await broadcast(
                room,
                {
                    "type": "discussion_started",
                    "participant_count": len(room.connections),
                },
            )
            greeting = "Welcome everyone! I am your GD Meet moderator."
            topic_announcement = f"Today's group discussion topic is: {room.topic}"
            for text in (greeting, topic_announcement):
                room.transcript.append(
                    {"timestamp": timestamp(), "speaker": "Agent", "text": text}
                )
                await broadcast(room, {"type": "agent", "text": text})
        elif not room.started:
            await websocket.send_json(
                {
                    "type": "waiting_for_participants",
                    "participant_count": len(room.connections),
                    "required_count": MIN_PARTICIPANTS_TO_START,
                }
            )

    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except ValueError:
                await websocket.send_json({"type": "error", "text": "Send a valid JSON message."})
                continue
            if not isinstance(payload, dict):
                await websocket.send_json({"type": "error", "text": "Message must be a JSON object."})
                continue
            message_type = payload.get("type")
            if message_type == "transcript":
                text = str(payload.get("text", "")).strip()[:1000]
                if not text:
                    continue
                entry = {"timestamp": timestamp(), "speaker": participant.name, "text": text}
                room.transcript.append(entry)
                await broadcast(room, {"type": "transcript", **entry})
            elif message_type in {"offer", "answer", "ice_candidate"}:
                target_id = str(payload.get("target_id", ""))
                target = next(
                    (
                        connection
                        for connection, other in room.connections.items()
                        if other.id == target_id
                    ),
                    None,
                )
                if target is None:
                    await websocket.send_json(
                        {"type": "error", "text": "The other participant is no longer in the room."}
                    )
                    continue
                await target.send_json(
                    {
                        "type": "signal",
                        "signal_type": message_type,
                        "from_id": participant.id,
                        "payload": payload.get("payload"),
                    }
                )
            elif message_type == "end":
                if not is_host:
                    await websocket.send_json(
                        {"type": "error", "text": "Only the meeting creator can end the discussion."}
                    )
                    continue
                if room.ended:
                    continue
                room.ended = True
                await broadcast(room, {"type": "meeting_ending"})
                await asyncio.sleep(1.5)
                thank_you = {
                    "timestamp": timestamp(),
                    "speaker": "Agent",
                    "text": "Thank you everyone for participating. The discussion has ended.",
                }
                room.transcript.append(thank_you)
                await broadcast(room, {"type": "agent", "text": thank_you["text"]})
                try:
                    room.ai_analysis = await asyncio.to_thread(
                        analyze_discussion,
                        room.topic,
                        room.transcript,
                        sorted(room.participants),
                    )
                except GeminiAnalysisError as error:
                    room.ai_analysis_error = str(error)
                    logger.warning("Gemini analysis unavailable for room %s: %s", room.id, error)
                await broadcast(room, {"type": "report", "report": build_report(room)})
                for connection in tuple(room.connections):
                    await connection.close(code=1000, reason="Meeting ended")
                break
            else:
                await websocket.send_json({"type": "error", "text": "Unsupported message type."})
    except WebSocketDisconnect:
        pass
    finally:
        room.connections.pop(websocket, None)
        if not room.ended:
            await broadcast(
                room,
                {"type": "participant_left", "id": participant.id, "name": participant.name},
            )
