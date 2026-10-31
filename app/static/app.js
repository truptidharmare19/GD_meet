const setupPanel = document.querySelector("#setup");
const roomPanel = document.querySelector("#room");
const statusMessage = document.querySelector("#setup-status");
const speechStatus = document.querySelector("#speech-status");
const messageBox = document.querySelector("#messages");
const reportPanel = document.querySelector("#report");
const videoGrid = document.querySelector("#video-grid");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const peerConnections = new Map();
const peerNames = new Map();
const pendingIceCandidates = new Map();
let socket;
let localStream;
let recognition;
let recognitionEnabled = false;
let agentSpeaking = false;
let speechQueue = [];
let participantName = "";
let hostToken = "";
let roomId = "";
let isHost = false;
let localParticipantId = "";

function showStatus(message) {
  statusMessage.textContent = message;
}

function sendSocketMessage(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function renderMessage(speaker, text, kind = "") {
  const item = document.createElement("div");
  item.className = `message ${kind}`;
  const label = document.createElement("span");
  label.className = "message-meta";
  label.textContent = speaker;
  const body = document.createElement("span");
  body.textContent = text;
  item.append(label, body);
  messageBox.append(item);
  messageBox.scrollTop = messageBox.scrollHeight;
}

function addVideoTile(id, name, stream, local = false) {
  let tile = document.querySelector(`[data-participant-id="${CSS.escape(id)}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-tile";
    tile.dataset.participantId = id;
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = local;
    const label = document.createElement("span");
    label.className = "video-name";
    label.textContent = local ? `${name} (You)` : name;
    tile.append(video, label);
    videoGrid.append(tile);
  }
  const video = tile.querySelector("video");
  if (stream && video.srcObject !== stream) {
    video.srcObject = stream;
  }
  return tile;
}

function removeParticipant(id) {
  const connection = peerConnections.get(id);
  if (connection) {
    connection.close();
    peerConnections.delete(id);
  }
  pendingIceCandidates.delete(id);
  document.querySelector(`[data-participant-id="${CSS.escape(id)}"]`)?.remove();
}

function sendSignal(type, targetId, payload) {
  sendSocketMessage({ type, target_id: targetId, payload });
}

function createPeerConnection(peer) {
  let connection = peerConnections.get(peer.id);
  if (connection) return connection;

  connection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  peerConnections.set(peer.id, connection);
  for (const track of localStream.getTracks()) {
    connection.addTrack(track, localStream);
  }
  connection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal("ice_candidate", peer.id, event.candidate.toJSON());
    }
  };
  connection.ontrack = (event) => {
    addVideoTile(peer.id, peer.name, event.streams[0]);
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "failed" || connection.connectionState === "closed") {
      removeParticipant(peer.id);
    }
  };
  return connection;
}

async function offerParticipant(peer) {
  const connection = createPeerConnection(peer);
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  sendSignal("offer", peer.id, connection.localDescription.toJSON());
}

async function handleSignal(data) {
  const name = peerNames.get(data.from_id) || "Participant";
  const peer = { id: data.from_id, name };
  const connection = createPeerConnection(peer);

  if (data.signal_type === "offer") {
    await connection.setRemoteDescription(data.payload);
    await applyPendingCandidates(connection, peer.id);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    sendSignal("answer", peer.id, connection.localDescription.toJSON());
  } else if (data.signal_type === "answer") {
    await connection.setRemoteDescription(data.payload);
    await applyPendingCandidates(connection, peer.id);
  } else if (data.signal_type === "ice_candidate" && data.payload) {
    if (connection.remoteDescription) {
      await connection.addIceCandidate(data.payload);
    } else {
      const candidates = pendingIceCandidates.get(peer.id) || [];
      candidates.push(data.payload);
      pendingIceCandidates.set(peer.id, candidates);
    }
  }
}

async function applyPendingCandidates(connection, peerId) {
  const candidates = pendingIceCandidates.get(peerId) || [];
  pendingIceCandidates.delete(peerId);
  for (const candidate of candidates) {
    await connection.addIceCandidate(candidate);
  }
}

function startRecognition() {
  if (!recognition || !recognitionEnabled || agentSpeaking) return;
  try {
    recognition.start();
  } catch (error) {
    if (error.name !== "InvalidStateError") {
      speechStatus.textContent = "Speech recognition could not start in this browser.";
    }
  }
}

function stopRecognition() {
  recognitionEnabled = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") throw error;
    }
  }
}

function setupRecognition() {
  if (!SpeechRecognition) {
    speechStatus.textContent = "Live captions need Chrome or Edge. Audio/video still works.";
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = navigator.language || "en-US";
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result.isFinal) continue;
      const text = result[0].transcript.trim();
      if (text) sendSocketMessage({ type: "transcript", text });
    }
  };
  recognition.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted") {
      speechStatus.textContent = `Speech recognition: ${event.error}.`;
    }
  };
  recognition.onend = () => {
    if (recognitionEnabled && !agentSpeaking) {
      window.setTimeout(startRecognition, 250);
    }
  };
  recognitionEnabled = false;
}

function startDiscussionRecognition() {
  if (!recognition) return;
  recognitionEnabled = true;
  startRecognition();
}

function speakNextAgentMessage() {
  if (!("speechSynthesis" in window) || !speechQueue.length) {
    agentSpeaking = false;
    if (recognitionEnabled) startRecognition();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(speechQueue.shift());
  utterance.onend = speakNextAgentMessage;
  utterance.onerror = speakNextAgentMessage;
  window.speechSynthesis.speak(utterance);
}

function speakAgent(text) {
  if (!("speechSynthesis" in window)) return;
  speechQueue.push(text);
  if (agentSpeaking) return;
  agentSpeaking = true;
  if (recognition) recognition.stop();
  speakNextAgentMessage();
}

function makeTranscriptText(report) {
  const lines = [
    "GD Meet — Discussion Transcript",
    `Topic: ${report.topic}`,
    `Room: ${report.room_id}`,
    "",
    ...report.transcript.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      return `[${time}] ${entry.speaker}: ${entry.text}`;
    }),
    "",
    "Participation summary",
    ...report.scores.map(
      (score) =>
        `${score.participant}: ${score.participation_score}/100, ${score.contribution_turns} turns, ${score.word_count} words`,
    ),
  ];
  if (report.ai_analysis) {
    lines.push("", "Gemini discussion feedback", report.ai_analysis.summary);
    if (report.ai_analysis.key_points.length) {
      lines.push("Key points:", ...report.ai_analysis.key_points.map((point) => `- ${point}`));
    }
    for (const evaluation of report.ai_analysis.participant_evaluations) {
      lines.push(
        "",
        `${evaluation.participant}: ${evaluation.discussion_score}/100`,
        `Evidence: ${evaluation.evidence.join(" ")}`,
        `Strengths: ${evaluation.strengths.join(" ")}`,
        `Suggestions: ${evaluation.suggestions.join(" ")}`,
      );
    }
  } else if (report.ai_analysis_error) {
    lines.push("", `Gemini report unavailable: ${report.ai_analysis_error}`);
  }
  return `${lines.join("\n")}\n`;
}

function downloadTranscript(report) {
  const blob = new Blob([makeTranscriptText(report)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gd-meet-${report.room_id}-transcript.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderReport(report) {
  reportPanel.replaceChildren();
  reportPanel.classList.remove("hidden");

  const title = document.createElement("h3");
  title.textContent = "Discussion report";
  const topic = document.createElement("p");
  topic.textContent = `Topic: ${report.topic}`;
  const downloadButton = document.createElement("button");
  downloadButton.className = "button button-primary";
  downloadButton.textContent = "Download transcript (.txt)";
  downloadButton.addEventListener("click", () => downloadTranscript(report));
  reportPanel.append(title, topic, downloadButton);

  if (report.ai_analysis) {
    const analysisHeading = document.createElement("h3");
    analysisHeading.textContent = "Gemini discussion feedback";
    const summary = document.createElement("p");
    summary.textContent = report.ai_analysis.summary;
    reportPanel.append(analysisHeading, summary);

    if (report.ai_analysis.key_points.length) {
      const pointsHeading = document.createElement("strong");
      pointsHeading.textContent = "Key points";
      const points = document.createElement("ul");
      for (const point of report.ai_analysis.key_points) {
        const item = document.createElement("li");
        item.textContent = point;
        points.append(item);
      }
      reportPanel.append(pointsHeading, points);
    }

    for (const evaluation of report.ai_analysis.participant_evaluations) {
      const card = document.createElement("div");
      card.className = "evaluation-card";
      const participant = document.createElement("strong");
      participant.textContent = `${evaluation.participant}: ${evaluation.discussion_score}/100`;
      const feedback = document.createElement("p");
      feedback.textContent = `Evidence: ${evaluation.evidence.join(" ")} Strengths: ${evaluation.strengths.join(" ")}`;
      const suggestions = document.createElement("p");
      suggestions.textContent = `To try next time: ${evaluation.suggestions.join(" ")}`;
      card.append(participant, feedback, suggestions);
      reportPanel.append(card);
    }
  } else {
    const aiStatus = document.createElement("p");
    aiStatus.textContent = report.ai_analysis_error || "Gemini analysis was not available for this discussion.";
    reportPanel.append(aiStatus);
  }

  const scores = document.createElement("div");
  scores.className = "score-list";
  for (const result of report.scores) {
    const card = document.createElement("div");
    card.className = "score-item";
    const name = document.createElement("strong");
    name.textContent = result.participant;
    const details = document.createElement("span");
    details.textContent = `${result.participation_score}/100 · ${result.contribution_turns} turns · ${result.word_count} words`;
    card.append(name, details);
    scores.append(card);
  }

  const transcriptTitle = document.createElement("h3");
  transcriptTitle.textContent = "Transcript";
  const transcript = document.createElement("ol");
  transcript.className = "transcript-list";
  for (const entry of report.transcript) {
    const line = document.createElement("li");
    line.textContent = `${entry.speaker}: ${entry.text}`;
    transcript.append(line);
  }
  reportPanel.append(scores, transcriptTitle, transcript);
  reportPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function startMeeting(id, token = "") {
  roomId = id;
  hostToken = token;
  isHost = Boolean(token);
  participantName = document.querySelector("#participant-name").value.trim() || "Participant";
  showStatus("");

  if (!navigator.mediaDevices?.getUserMedia) {
    showStatus("Camera and microphone access requires HTTPS or localhost in a supported browser.");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: true,
    });
  } catch (error) {
    showStatus(`Camera/microphone permission is required to join: ${error.message}`);
    return;
  }

  setupPanel.classList.add("hidden");
  roomPanel.classList.remove("hidden");
  addVideoTile("local", participantName, localStream, true);
  const agentTile = document.createElement("div");
  agentTile.className = "video-tile agent-tile";
  agentTile.innerHTML = '<div class="agent-avatar">A</div><strong>GD Meet Agent</strong><small>Welcomes the group, then listens quietly</small>';
  videoGrid.append(agentTile);
  document.querySelector("#end-room").classList.toggle("hidden", !isHost);
  document.querySelector("#invite-card").classList.toggle("hidden", !isHost);
  speechStatus.textContent = "Waiting for another participant to join before the discussion starts.";

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ name: participantName });
  if (hostToken) query.set("host_token", hostToken);
  socket = new WebSocket(`${protocol}//${window.location.host}/ws/rooms/${roomId}?${query}`);

  socket.addEventListener("open", () => {
    setupRecognition();
    if (isHost) document.querySelector("#end-room").disabled = false;
  });

  socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);
    try {
      if (data.type === "participants") {
        for (const peer of data.participants) {
          peerNames.set(peer.id, peer.name);
          await offerParticipant(peer);
        }
      } else if (data.type === "room_info") {
        if (data.started) {
          document.querySelector("#room-topic").textContent = data.topic;
        } else {
          document.querySelector("#room-topic").textContent = "Waiting for participants";
          speechStatus.textContent = SpeechRecognition
            ? "Waiting for another participant to join before the discussion starts."
            : "Waiting for another participant. Captions need Chrome or Edge.";
        }
      } else if (data.type === "participant_joined") {
        if (data.id !== localParticipantId) {
          if (!localParticipantId) localParticipantId = data.id;
          peerNames.set(data.id, data.name);
          renderMessage("Room", `${data.name} joined the meeting.`, "agent");
        }
      } else if (data.type === "participant_left") {
        peerNames.delete(data.id);
        removeParticipant(data.id);
        renderMessage("Room", `${data.name} left the meeting.`, "agent");
      } else if (data.type === "signal") {
        await handleSignal(data);
      } else if (data.type === "waiting_for_participants") {
        document.querySelector("#room-topic").textContent = "Waiting for participants";
        const remaining = data.required_count - data.participant_count;
        speechStatus.textContent = `Waiting for ${remaining} more participant${remaining === 1 ? "" : "s"} before the moderator starts.`;
      } else if (data.type === "discussion_started") {
        speechStatus.textContent = SpeechRecognition
          ? "The discussion has started. Listening for speech to build the transcript."
          : "The discussion has started. Audio/video is live; captions need Chrome or Edge.";
        startDiscussionRecognition();
      } else if (data.type === "agent") {
        renderMessage("GD Meet Agent", data.text, "agent");
        speakAgent(data.text);
        if (data.text.startsWith("Today's group discussion topic is: ")) {
          document.querySelector("#room-topic").textContent =
            data.text.replace("Today's group discussion topic is: ", "");
        }
      } else if (data.type === "transcript") {
        renderMessage(data.speaker, data.text, data.speaker === participantName ? "mine" : "");
      } else if (data.type === "meeting_ending") {
        stopRecognition();
        speechStatus.textContent = "Meeting ended. Preparing the transcript and report…";
      } else if (data.type === "report") {
        renderReport(data.report);
        stopMedia();
        document.querySelector("#end-room").disabled = true;
      } else if (data.type === "error") {
        renderMessage("Room", data.text, "agent");
      }
    } catch (error) {
      console.error("Could not process meeting event:", error);
      speechStatus.textContent = "A meeting event could not be processed. Check your connection.";
    }
  });

  socket.addEventListener("close", (event) => {
    if (!roomPanel.classList.contains("hidden") && event.code !== 1000) {
      stopMedia();
      if ([4403, 4404, 4409].includes(event.code)) {
        roomPanel.classList.add("hidden");
        setupPanel.classList.remove("hidden");
        showStatus(event.reason || "Could not join this meeting. Check the link and try again.");
      } else {
        speechStatus.textContent = event.reason || "The meeting connection closed.";
      }
    } else if (roomPanel.classList.contains("hidden")) {
      showStatus(event.reason || "Could not join this meeting. Check the link and try again.");
    }
  });
  socket.addEventListener("error", () => {
    speechStatus.textContent = "Could not connect to the meeting. Check your connection and link.";
  });
}

function stopMedia() {
  stopRecognition();
  for (const connection of peerConnections.values()) {
    connection.close();
  }
  peerConnections.clear();
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
    localStream = null;
  }
}

function configureJoinPage() {
  const match = window.location.pathname.match(/^\/join\/([a-f0-9]+)$/i);
  if (!match) return;
  roomId = match[1];
  document.querySelector("#setup-title").textContent = "Join the discussion";
  document.querySelector("#create-fields").classList.add("hidden");
  document.querySelector("#join-fields").classList.remove("hidden");
}

document.querySelector("#create-room").addEventListener("click", async () => {
  if (!document.querySelector("#transcript-consent").checked) {
    showStatus("Please confirm that you understand how the transcript is processed.");
    return;
  }
  showStatus("");
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
    });
    if (!response.ok) throw new Error("Could not create the meeting.");
    const room = await response.json();
    const inviteLink = new URL(`/join/${room.room_id}`, window.location.origin).href;
    document.querySelector("#invite-link").value = inviteLink;
    await startMeeting(room.room_id, room.host_token);
  } catch (error) {
    showStatus(error.message);
  }
});

document.querySelector("#join-room").addEventListener("click", () => {
  if (!document.querySelector("#transcript-consent").checked) {
    showStatus("Please confirm that you understand how the transcript is processed.");
    return;
  }
  startMeeting(roomId);
});

document.querySelector("#copy-link").addEventListener("click", async () => {
  const button = document.querySelector("#copy-link");
  try {
    await navigator.clipboard.writeText(document.querySelector("#invite-link").value);
    button.textContent = "Copied!";
  } catch {
    document.querySelector("#invite-link").select();
    document.execCommand("copy");
    button.textContent = "Copied!";
  }
});

document.querySelector("#toggle-mic").addEventListener("click", (event) => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  event.currentTarget.textContent = track.enabled ? "Mute mic" : "Unmute mic";
  event.currentTarget.setAttribute("aria-pressed", String(!track.enabled));
  if (track.enabled) {
    recognitionEnabled = true;
    startRecognition();
  } else {
    stopRecognition();
  }
});

document.querySelector("#toggle-camera").addEventListener("click", (event) => {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  event.currentTarget.textContent = track.enabled ? "Turn camera off" : "Turn camera on";
  event.currentTarget.setAttribute("aria-pressed", String(!track.enabled));
});

document.querySelector("#end-room").addEventListener("click", () => {
  if (!isHost || socket?.readyState !== WebSocket.OPEN) return;
  document.querySelector("#end-room").disabled = true;
  stopRecognition();
  sendSocketMessage({ type: "end" });
});

configureJoinPage();
