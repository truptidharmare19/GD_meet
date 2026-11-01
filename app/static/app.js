const setupPanel = document.querySelector("#setup");
const roomPanel = document.querySelector("#room");
const statusMessage = document.querySelector("#setup-status");
const speechStatus = document.querySelector("#speech-status");
const reportPanel = document.querySelector("#report");
const videoGrid = document.querySelector("#video-grid");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const peerConnections = new Map();
const peerNames = new Map();
const pendingIceCandidates = new Map();
let iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
let socket;
let localStream;
let screenShareStream;
let screenShareTrack;
let recognition;
let recognitionEnabled = false;
let lastCaptionText = "";
let lastCaptionTime = 0;
let agentSpeaking = false;
let speechQueue = [];
let participantName = "";
let hostToken = "";
let roomId = "";
let isHost = false;
let localParticipantId = "";
let audioPlaybackUnlocked = false;

function ensureScreenShareButton() {
  let button = document.querySelector("#toggle-screen-share");
  if (button) return button;
  const cameraButton = document.querySelector("#toggle-camera");
  button = document.createElement("button");
  button.type = "button";
  button.className = "control-button";
  button.id = "toggle-screen-share";
  button.setAttribute("aria-pressed", "false");
  button.textContent = "Share screen";
  cameraButton.insertAdjacentElement("afterend", button);
  return button;
}

ensureScreenShareButton();

function updateMicrophoneButton() {
  const button = document.querySelector("#toggle-mic");
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  button.textContent = track.enabled ? "Mute mic" : "Unmute mic";
  button.setAttribute("aria-pressed", String(track.enabled));
  button.setAttribute(
    "aria-label",
    track.enabled ? "Microphone on; mute microphone" : "Microphone muted; unmute microphone",
  );
}

async function enableRemoteAudio() {
  const audioElements = [...document.querySelectorAll(".remote-audio")];
  const results = await Promise.allSettled(audioElements.map((audio) => audio.play()));
  const failures = results.filter((result) => result.status === "rejected");
  audioPlaybackUnlocked = failures.length === 0;
  if (failures.length) {
    console.warn("Browser blocked participant audio playback:", failures);
    speechStatus.textContent = "The browser blocked audio. Check site sound permission and device media volume, then tap Enable audio again.";
  } else if (audioElements.length) {
    speechStatus.textContent = "Participant audio is enabled.";
  } else {
    speechStatus.textContent = "Audio is enabled. You will hear participants when they connect.";
  }
}

async function updateAudioDiagnostics() {
  if (!localStream || !peerConnections.size) return;
  const microphone = localStream.getAudioTracks()[0];
  if (!microphone?.enabled) {
    speechStatus.textContent = "Your microphone is muted. Tap Unmute mic to let others hear you.";
    return;
  }

  try {
    const peers = await Promise.all([...peerConnections.values()].map(async (connection) => {
      const stats = await connection.getStats();
      let inboundAudio = 0;
      let outboundAudio = 0;
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) {
          inboundAudio += report.bytesReceived || 0;
        } else if (report.type === "outbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) {
          outboundAudio += report.bytesSent || 0;
        }
      });
      return { state: connection.connectionState, inboundAudio, outboundAudio };
    }));

    if (peers.some((peer) => peer.state === "failed")) {
      speechStatus.textContent = "Voice could not reach a participant. This network may require TURN relay configuration.";
    } else if (peers.every((peer) => peer.state === "connected") && peers.every((peer) => peer.inboundAudio === 0)) {
      speechStatus.textContent = "Connected, but no participant audio is arriving. Ask them to unmute and check mic permission.";
    } else if (peers.some((peer) => peer.state === "connected" && peer.inboundAudio > 0)) {
      speechStatus.textContent = "Participant audio is arriving. If you cannot hear it, tap Enable audio and check device volume.";
    } else if (peers.every((peer) => peer.state === "connected") && peers.every((peer) => peer.outboundAudio === 0)) {
      speechStatus.textContent = "Connected, but your microphone is sending no audio. Check the selected mic and browser permission.";
    }
  } catch (error) {
    console.warn("Could not inspect WebRTC audio stats:", error);
  }
}

function showStatus(message) {
  statusMessage.textContent = message;
}

function sendSocketMessage(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
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
    video.muted = true;
    tile.addEventListener("click", () => {
      video.play().catch((error) => console.error("Could not start video playback:", error));
      tile.querySelector("audio")?.play().catch((error) => {
        console.error("Could not start participant audio:", error);
        speechStatus.textContent = "Tap Enable audio to hear participants on this device.";
      });
    });
    const label = document.createElement("span");
    label.className = "video-name";
    label.textContent = local ? `${name} (You)` : name;
    tile.append(video, label);
    if (!local) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.className = "remote-audio";
      tile.append(audio);
    }
    videoGrid.append(tile);
  }
  const video = tile.querySelector("video");
  if (stream && video.srcObject !== stream) {
    video.srcObject = stream;
    video.play().catch((error) => {
      console.warn("Browser blocked video playback:", error);
      speechStatus.textContent = "Tap a participant tile to enable media playback.";
    });
  }
  const audio = tile.querySelector("audio");
  if (audio && stream && audio.srcObject !== stream) {
    audio.srcObject = stream;
    audio.play().catch((error) => {
      console.warn("Browser blocked participant audio:", error);
      if (!audioPlaybackUnlocked) {
        speechStatus.textContent = "Tap Enable audio to hear participants on this device.";
      }
    });
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

  connection = new RTCPeerConnection({ iceServers });
  peerConnections.set(peer.id, connection);
  for (const track of localStream.getAudioTracks()) {
    connection.addTrack(track, localStream);
  }
  const videoTrack = screenShareTrack || localStream.getVideoTracks()[0];
  if (videoTrack) {
    connection.addTrack(videoTrack, screenShareStream || localStream);
  }
  connection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal("ice_candidate", peer.id, event.candidate.toJSON());
    }
  };
  connection.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    addVideoTile(peer.id, peer.name, stream);
    if (event.track.kind === "audio") {
      event.track.addEventListener("unmute", () => {
        speechStatus.textContent = `${peer.name}'s audio is connected.`;
      }, { once: true });
    }
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "failed" || connection.connectionState === "closed") {
      if (connection.connectionState === "failed") {
        speechStatus.textContent = "Participant media could not connect. This network likely requires TURN configuration.";
      }
      removeParticipant(peer.id);
    } else if (connection.connectionState === "connected") {
      speechStatus.textContent = "Participant audio/video connected.";
    }
  };
  connection.oniceconnectionstatechange = () => {
    if (connection.iceConnectionState === "failed") {
      speechStatus.textContent = "Media could not reach the other device. Configure a TURN relay; ngrok does not relay call audio.";
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
      const now = Date.now();
      if (text && (text !== lastCaptionText || now - lastCaptionTime > 2000)) {
        lastCaptionText = text;
        lastCaptionTime = now;
        sendSocketMessage({ type: "transcript", text });
      }
    }
  };
  recognition.onerror = (event) => {
    if (["audio-capture", "not-allowed", "service-not-allowed", "network"].includes(event.error)) {
      recognitionEnabled = false;
      speechStatus.textContent = event.error === "network"
        ? "Live captions stopped because the browser speech-recognition service is unreachable. Meeting audio is separate from captions."
        : "Live captions are unavailable because this browser cannot use the microphone for recognition during the call. Meeting audio is separate from captions.";
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
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
  utterance.onerror = (event) => {
    console.warn("Moderator speech could not play:", event.error);
    speechStatus.textContent = "Moderator voice could not play in this browser. Check device volume and audio permissions.";
    speakNextAgentMessage();
  };
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

function renderReport(report) {
  reportPanel.replaceChildren();
  reportPanel.classList.remove("hidden");

  const title = document.createElement("h3");
  title.textContent = "Discussion report";
  const topic = document.createElement("p");
  topic.textContent = `Topic: ${report.topic}`;
  const transcriptStatus = document.createElement("p");
  transcriptStatus.textContent = report.transcript_file_error
    ? report.transcript_file_error
    : "Transcript and discussion report card saved to transcript.txt in the project folder.";
  reportPanel.append(title, topic, transcriptStatus);

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

  reportPanel.append(scores);
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
    const response = await fetch("/api/ice-servers");
    const configuration = await response.json();
    if (!response.ok) {
      throw new Error(configuration.detail || "Could not load WebRTC network settings.");
    }
    if (!Array.isArray(configuration.ice_servers) || !configuration.ice_servers.length) {
      throw new Error("The server returned no WebRTC ICE servers.");
    }
    iceServers = configuration.ice_servers;
  } catch (error) {
    showStatus(`Could not configure meeting audio/video: ${error.message}`);
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
  for (const track of localStream.getAudioTracks()) {
    track.enabled = true;
  }
  updateMicrophoneButton();
  document.querySelector("#enable-audio").hidden = false;
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
    window.clearInterval(audioDiagnosticsTimer);
    audioDiagnosticsTimer = window.setInterval(updateAudioDiagnostics, 4000);
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
          if (data.topic) {
            document.querySelector("#room-topic").textContent = data.topic;
          } else {
            document.querySelector("#room-topic").textContent = "Waiting for everyone to join";
            speechStatus.textContent = "The moderator is checking attendance. Say “yes” when everyone has joined.";
            startDiscussionRecognition();
          }
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
        }
      } else if (data.type === "participant_left") {
        peerNames.delete(data.id);
        removeParticipant(data.id);
        speechStatus.textContent = `${data.name} left the meeting.`;
      } else if (data.type === "signal") {
        await handleSignal(data);
      } else if (data.type === "waiting_for_participants") {
        document.querySelector("#room-topic").textContent = "Waiting for participants";
        const remaining = data.required_count - data.participant_count;
        speechStatus.textContent = `Waiting for ${remaining} more participant${remaining === 1 ? "" : "s"} before the moderator starts.`;
      } else if (data.type === "discussion_started") {
        speechStatus.textContent = SpeechRecognition
          ? "The moderator is checking attendance. Say “yes” when everyone has joined."
          : "The moderator is checking attendance. Captions need Chrome or Edge; audio/video is live.";
        startDiscussionRecognition();
      } else if (data.type === "agent") {
        speakAgent(data.text);
        if (data.text.startsWith("Today's group discussion topic is: ")) {
          document.querySelector("#room-topic").textContent =
            data.text.replace("Today's group discussion topic is: ", "");
          speechStatus.textContent = "The topic is announced. The group discussion can begin.";
        }
      } else if (data.type === "transcript") {
        speechStatus.textContent = "Captions are being saved to transcript.txt.";
      } else if (data.type === "transcript_saved") {
        speechStatus.textContent = "Transcript saved to transcript.txt in the project folder.";
      } else if (data.type === "meeting_ending") {
        stopRecognition();
        speechStatus.textContent = "Meeting ended. Preparing the transcript and report…";
      } else if (data.type === "report") {
        renderReport(data.report);
        stopMedia();
        window.clearInterval(audioDiagnosticsTimer);
        document.querySelector("#end-room").disabled = true;
      } else if (data.type === "error") {
        speechStatus.textContent = data.text;
      }
    } catch (error) {
      console.error("Could not process meeting event:", error);
      speechStatus.textContent = "A meeting event could not be processed. Check your connection.";
    }
  });

  socket.addEventListener("close", (event) => {
    window.clearInterval(audioDiagnosticsTimer);
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
  window.clearInterval(audioDiagnosticsTimer);
  const activeScreenTrack = screenShareTrack;
  screenShareTrack = null;
  screenShareStream = null;
  activeScreenTrack?.stop();
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
  updateMicrophoneButton();
  if (track.enabled) {
    recognitionEnabled = true;
    startRecognition();
  } else {
    stopRecognition();
  }
});

document.querySelector("#enable-audio").addEventListener("click", enableRemoteAudio);

document.querySelector("#toggle-camera").addEventListener("click", (event) => {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  event.currentTarget.textContent = track.enabled ? "Turn camera off" : "Turn camera on";
  event.currentTarget.setAttribute("aria-pressed", String(!track.enabled));
});

ensureScreenShareButton().addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (screenShareTrack) {
    await stopScreenShare();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    speechStatus.textContent = "Screen sharing is not supported in this browser.";
    return;
  }

  try {
    screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenShareTrack = screenShareStream.getVideoTracks()[0];
    if (!screenShareTrack) {
      screenShareStream.getTracks().forEach((track) => track.stop());
      screenShareStream = null;
      throw new Error("No screen or window was selected.");
    }

    await Promise.all([...peerConnections.values()].map(async (connection) => {
      const sender = connection.getSenders().find((item) => item.track?.kind === "video");
      if (sender) await sender.replaceTrack(screenShareTrack);
    }));
    addVideoTile("local", participantName, screenShareStream, true);
    button.textContent = "Stop sharing";
    button.setAttribute("aria-pressed", "true");
    speechStatus.textContent = "Your screen is being shared with participants.";
    screenShareTrack.addEventListener("ended", () => {
      void stopScreenShare();
    }, { once: true });
  } catch (error) {
    console.error("Could not start screen sharing:", error);
    let cameraRestored = true;
    try {
      await Promise.all([...peerConnections.values()].map(async (connection) => {
        const sender = connection.getSenders().find((item) => item.track === screenShareTrack);
        if (sender) await sender.replaceTrack(localStream?.getVideoTracks()[0] || null);
      }));
    } catch (restoreError) {
      cameraRestored = false;
      console.error("Could not restore the camera after screen sharing failed:", restoreError);
    }
    const failedStream = screenShareStream;
    screenShareStream = null;
    screenShareTrack = null;
    failedStream?.getTracks().forEach((track) => track.stop());
    speechStatus.textContent = !cameraRestored
      ? "Screen sharing failed and the camera could not be restored. Rejoin the meeting."
      : error.name === "NotAllowedError"
        ? "Screen sharing was cancelled or not allowed."
        : `Could not share your screen: ${error.message}`;
  }
});

async function stopScreenShare() {
  const track = screenShareTrack;
  if (!track) return;
  screenShareTrack = null;
  const stream = screenShareStream;
  screenShareStream = null;
  const cameraTrack = localStream?.getVideoTracks()[0];
  let restored = true;

  try {
    await Promise.all([...peerConnections.values()].map(async (connection) => {
      const sender = connection.getSenders().find((item) => item.track === track);
      if (sender) await sender.replaceTrack(cameraTrack || null);
    }));
  } catch (error) {
    restored = false;
    console.error("Could not restore the camera after screen sharing:", error);
    speechStatus.textContent = "Screen sharing stopped, but the camera could not be restored. Rejoin the meeting.";
  }

  track.stop();
  stream?.getTracks().forEach((streamTrack) => {
    if (streamTrack !== track) streamTrack.stop();
  });
  if (localStream) addVideoTile("local", participantName, localStream, true);
  const button = document.querySelector("#toggle-screen-share");
  button.textContent = "Share screen";
  button.setAttribute("aria-pressed", "false");
  if (restored && cameraTrack) speechStatus.textContent = "Your camera is visible to participants.";
}

document.querySelector("#end-room").addEventListener("click", () => {
  if (!isHost || socket?.readyState !== WebSocket.OPEN) return;
  document.querySelector("#end-room").disabled = true;
  stopRecognition();
  sendSocketMessage({ type: "end" });
});

configureJoinPage();
