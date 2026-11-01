from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
import secrets
import time
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
        self.transcript_file_error: str | None = None
        self.started = False
        self.topic_announced = False
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
        "transcript_file_error": room.transcript_file_error,
    }


def append_transcript_file(room: Room) -> None:
    transcript_path = BASE_DIR.parent / "transcript.txt"
    lines = [
        "",
        "=" * 72,
        f"Meeting {room.id} | {datetime.now().astimezone().isoformat()}",
        f"Topic: {room.topic}",
        "",
    ]
    lines.extend(
        f"[{entry['timestamp']}] {entry['speaker']}: {entry['text']}"
        for entry in room.transcript
    )
    with transcript_path.open("a", encoding="utf-8", newline="\n") as transcript_file:
        transcript_file.write("\n".join(lines))
        transcript_file.write("\n")


def append_report_file(room: Room) -> None:
    report_path = BASE_DIR.parent / "transcript.txt"
    lines = [
        "",
        "=" * 72,
        f"Discussion report | Meeting {room.id}",
        f"Topic: {room.topic}",
        "",
    ]
    if room.ai_analysis:
        lines.extend(
            [
                "Discussion summary:",
                room.ai_analysis["summary"],
                "",
                "Key points:",
                *(f"- {point}" for point in room.ai_analysis["key_points"]),
                "",
                "Participant report cards:",
            ]
        )
        for evaluation in room.ai_analysis["participant_evaluations"]:
            lines.extend(
                [
                    "",
                    (
                        f"{evaluation['participant']} — "
                        f"{evaluation['discussion_score']}/100"
                    ),
                    f"Evidence: {' '.join(evaluation['evidence'])}",
                    f"Strengths: {' '.join(evaluation['strengths'])}",
                    f"To improve: {' '.join(evaluation['suggestions'])}",
                ]
            )
    else:
        lines.extend(
            [
                "Participant report cards could not be generated.",
                room.ai_analysis_error or "AI feedback was unavailable.",
            ]
        )

    with report_path.open("a", encoding="utf-8", newline="\n") as report_file:
        report_file.write("\n".join(lines))
        report_file.write("\n")


@app.get("/")
async def home() -> FileResponse:
    return FileResponse(
        BASE_DIR / "static" / "index.html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/join/{room_id}")
async def join_page(room_id: str) -> FileResponse:
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Meeting not found.")
    return FileResponse(
        BASE_DIR / "static" / "index.html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/ice-servers")
async def get_ice_servers() -> dict[str, list[dict[str, Any]]]:
    ice_servers: list[dict[str, Any]] = [
        {"urls": ["stun:stun.l.google.com:19302"]}
    ]
    turn_urls = [
        url.strip()
        for url in os.getenv("TURN_URLS", "").split(",")
        if url.strip()
    ]
    if not turn_urls:
        return {"ice_servers": ice_servers}

    shared_secret = os.getenv("TURN_SHARED_SECRET", "")
    if not shared_secret:
        raise HTTPException(
            status_code=503,
            detail="TURN_URLS is configured without TURN_SHARED_SECRET.",
        )

    username = f"{int(time.time()) + 3600}:gd-meet"
    credential = base64.b64encode(
        hmac.new(
            shared_secret.encode(),
            username.encode(),
            hashlib.sha1,
        ).digest()
    ).decode()
    ice_servers.append(
        {
            "urls": turn_urls,
            "username": username,
            "credential": credential,
        }
    )
    return {"ice_servers": ice_servers}


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
                "topic": room.topic if room.topic_announced else None,
                "waiting_for_confirmation": room.started and not room.topic_announced,
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
                    "waiting_for_confirmation": True,
                },
            )
            moderator_messages = (
                "Welcome everyone! I am your GD Meet moderator.",
                "Has everyone joined the group discussion? Please say yes when everyone is here.",
            )
            for text in moderator_messages:
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
                normalized = text.rstrip(" .!?").casefold()
                affirmation_tokens = {
                    "yes",
                    "yeah",
                    "yep",
                    "yes we have joined",
                    "yes we have joined the meeting",
                    "we have joined",
                    "we joined",
                    "everyone joined",
                    "everyone has joined",
                }
                if (
                    room.started
                    and not room.topic_announced
                    and (
                        normalized in affirmation_tokens
                        or any(
                            phrase in normalized
                            for phrase in (
                                "yes we have joined",
                                "we have joined",
                                "everyone joined",
                                "everyone has joined",
                            )
                        )
                    )
                ):
                    async with room.lock:
                        if not room.topic_announced and not room.ended:
                            room.topic_announced = True
                            announcement = {
                                "timestamp": timestamp(),
                                "speaker": "Agent",
                                "text": f"Today's group discussion topic is: {room.topic}",
                            }
                            room.transcript.append(announcement)
                            await broadcast(room, {"type": "agent", "text": announcement["text"]})
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
                    await asyncio.to_thread(append_transcript_file, room)
                    await broadcast(room, {"type": "transcript_saved"})
                except OSError as error:
                    room.transcript_file_error = (
                        "Could not write transcript.txt in the project folder. "
                        "Check that the folder is writable."
                    )
                    logger.exception("Could not save transcript for room %s", room.id)
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
                except Exception:
                    room.ai_analysis_error = (
                        "Gemini is temporarily unavailable. The transcript was saved, "
                        "but AI feedback could not be generated."
                    )
                    logger.exception(
                        "Unexpected Gemini analysis failure for room %s",
                        room.id,
                    )
                try:
                    await asyncio.to_thread(append_report_file, room)
                except OSError:
                    room.transcript_file_error = (
                        "Could not save the discussion report to transcript.txt. "
                        "Check that the project folder is writable."
                    )
                    logger.exception("Could not save report for room %s", room.id)
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
