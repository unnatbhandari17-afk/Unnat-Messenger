/**
 * One-to-one WebRTC audio/video calling.
 *
 * The FastAPI backend is used ONLY to relay signalling messages (SDP
 * offer/answer, ICE candidates, ringing/accept/reject/cancel/end) over the
 * existing authenticated WebSocket connection — see the "call_*" events in
 * bindWebSocketEvents() below and their counterparts in backend/main.py.
 * Audio/video itself flows directly between the two browsers (peer-to-peer)
 * once the connection is established; it never touches the server.
 */
window.Calls = (function () {
  const ICE_SERVERS = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  const RING_TIMEOUT_MS = 45000;      // auto-cancel/reject an unanswered call
  const RECONNECT_GRACE_MS = 15000;   // how long to try recovering a dropped media path
  const STATS_POLL_MS = 3000;

  const el = (id) => document.getElementById(id);

  const state = {
    activePeer: null,       // { id, username, avatar_url } — the currently open direct-chat's other member
    activeChatId: null,
    callId: null,
    peerId: null,
    peerUsername: null,
    peerAvatar: null,
    type: "audio",           // 'audio' | 'video'
    role: null,               // 'caller' | 'callee'
    status: "idle",           // idle | ringing-out | ringing-in | connecting | connected | ending
    pc: null,
    localStream: null,
    remoteStream: null,
    pendingCandidates: [],
    remoteOfferSdp: null,
    muted: false,
    cameraOff: false,
    facingMode: "user",
    startTime: null,
    timerHandle: null,
    ringTimeoutHandle: null,
    reconnectHandle: null,
    statsHandle: null,
    ringtone: null,
  };

  // ---------------- Ringtone (generated — no external audio assets needed) ----------------
  function makeRingtone(freqA, freqB) {
    let ctx = null;
    let intervalHandle = null;
    return {
      start() {
        try {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) { return; }
        const beep = () => {
          if (!ctx) return;
          [freqA, freqB].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.35);
            gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + i * 0.35 + 0.05);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + i * 0.35 + 0.3);
            osc.connect(gain).connect(ctx.destination);
            osc.start(ctx.currentTime + i * 0.35);
            osc.stop(ctx.currentTime + i * 0.35 + 0.32);
          });
        };
        beep();
        intervalHandle = setInterval(beep, 2000);
      },
      stop() {
        clearInterval(intervalHandle);
        if (ctx) { ctx.close().catch(() => {}); ctx = null; }
      },
    };
  }
  const incomingRing = makeRingtone(523, 659);  // C5/E5 — incoming call
  const outgoingRing = makeRingtone(440, 440);  // A4 ringback

  // ---------------- Public API ----------------
  function setActivePeer(peer, chatId) {
    state.activePeer = peer;
    state.activeChatId = chatId;
  }

  function hangupIfActive() {
    if (state.status !== "idle") endCall();
  }

  async function startCall(type) {
    if (state.status !== "idle") { UI.toast("You're already in a call", "error"); return; }
    if (!state.activePeer) { UI.toast("Open a direct chat to start a call", "error"); return; }

    state.role = "caller";
    state.type = type;
    state.callId = generateCallId();
    state.peerId = state.activePeer.id;
    state.peerUsername = state.activePeer.username;
    state.peerAvatar = state.activePeer.avatar_url;

    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { facingMode: state.facingMode } : false,
      });
    } catch (err) {
      UI.toast("Couldn't access microphone" + (type === "video" ? "/camera" : ""), "error");
      resetState();
      return;
    }

    setupPeerConnection();
    state.localStream.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));
    if (type === "video") attachLocalPreview();

    showOutgoingUI();
    outgoingRing.start();
    state.status = "ringing-out";

    try {
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      WS.send({
        event: "call_invite",
        call_id: state.callId,
        to_user_id: state.peerId,
        chat_id: state.activeChatId,
        call_type: type,
        sdp: { type: offer.type, sdp: offer.sdp },
      });
    } catch (err) {
      UI.toast("Couldn't start the call", "error");
      endCall();
      return;
    }

    state.ringTimeoutHandle = setTimeout(() => {
      if (state.status === "ringing-out") {
        UI.toast("No answer", "error");
        sendSignalEnd("call_cancel");
        resetState();
      }
    }, RING_TIMEOUT_MS);
  }

  async function acceptCall() {
    if (state.status !== "ringing-in") return;
    incomingRing.stop();
    clearTimeout(state.ringTimeoutHandle);

    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: state.type === "video" ? { facingMode: state.facingMode } : false,
      });
    } catch (err) {
      UI.toast("Couldn't access microphone" + (state.type === "video" ? "/camera" : ""), "error");
      WS.send({ event: "call_reject", call_id: state.callId });
      resetState();
      return;
    }

    setupPeerConnection();
    state.localStream.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));
    if (state.type === "video") attachLocalPreview();

    try {
      await state.pc.setRemoteDescription(new RTCSessionDescription(state.remoteOfferSdp));
      flushPendingCandidates();
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      WS.send({
        event: "call_accept",
        call_id: state.callId,
        sdp: { type: answer.type, sdp: answer.sdp },
      });
    } catch (err) {
      UI.toast("Couldn't answer the call", "error");
      endCall();
      return;
    }

    state.status = "connecting";
    showActiveUI();
  }

  function rejectCall() {
    if (state.status !== "ringing-in") return;
    incomingRing.stop();
    WS.send({ event: "call_reject", call_id: state.callId });
    resetState();
  }

  function cancelCall() {
    if (state.status !== "ringing-out") return;
    outgoingRing.stop();
    sendSignalEnd("call_cancel");
    resetState();
  }

  function endCall() {
    if (state.status === "idle") return;
    outgoingRing.stop();
    incomingRing.stop();
    if (state.callId) sendSignalEnd("call_end");
    resetState();
    UI.toast("Call ended", "success");
  }

  function sendSignalEnd(eventName) {
    if (state.callId) WS.send({ event: eventName, call_id: state.callId });
  }

  // ---------------- In-call controls ----------------
  function toggleMute() {
    if (!state.localStream) return;
    state.muted = !state.muted;
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
    el("muteBtn").textContent = state.muted ? "🔇" : "🎤";
    el("muteBtn").classList.toggle("active-danger", state.muted);
    sendMuteState();
  }

  function toggleCamera() {
    if (!state.localStream || state.type !== "video") return;
    state.cameraOff = !state.cameraOff;
    state.localStream.getVideoTracks().forEach((t) => (t.enabled = !state.cameraOff));
    el("cameraToggleBtn").textContent = state.cameraOff ? "🚫" : "📷";
    el("cameraToggleBtn").classList.toggle("active-danger", state.cameraOff);
    el("localVideo").style.visibility = state.cameraOff ? "hidden" : "visible";
  }

  async function switchCamera() {
    if (!state.localStream || state.type !== "video") return;
    state.facingMode = state.facingMode === "user" ? "environment" : "user";
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facingMode }, audio: false });
      const newTrack = newStream.getVideoTracks()[0];
      const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
      const oldTrack = state.localStream.getVideoTracks()[0];
      state.localStream.removeTrack(oldTrack);
      oldTrack.stop();
      state.localStream.addTrack(newTrack);
      el("localVideo").srcObject = state.localStream;
    } catch (err) {
      UI.toast("Couldn't switch camera", "error");
    }
  }

  function toggleFullscreen() {
    const stage = el("callStage");
    if (!document.fullscreenElement) {
      stage.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }
  document.addEventListener("fullscreenchange", () => {
    const btn = el("fullscreenBtn");
    if (btn) btn.textContent = document.fullscreenElement ? "⤢" : "⛶";
  });

  function sendMuteState() {
    if (!state.callId) return;
    WS.send({ event: "call_signal", call_id: state.callId, signal_type: "mute-state", payload: { muted: state.muted } });
  }

  // ---------------- RTCPeerConnection plumbing ----------------
  function setupPeerConnection() {
    state.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    state.pc.onicecandidate = (e) => {
      if (e.candidate && state.callId) {
        WS.send({
          event: "call_signal",
          call_id: state.callId,
          signal_type: "ice-candidate",
          payload: e.candidate.toJSON(),
        });
      }
    };

    state.pc.ontrack = (e) => {
      state.remoteStream = e.streams[0];
      if (state.type === "video") {
        el("remoteVideo").srcObject = state.remoteStream;
      } else {
        el("remoteAudio").srcObject = state.remoteStream;
      }
    };

    state.pc.onconnectionstatechange = () => {
      const s = state.pc.connectionState;
      if (s === "connected") {
        clearTimeout(state.reconnectHandle);
        outgoingRing.stop();
        if (!state.startTime) startTimer();
        state.status = "connected";
        setStatusLabel("Connected");
        startStatsPolling();
      } else if (s === "disconnected") {
        setStatusLabel("Reconnecting…");
        clearTimeout(state.reconnectHandle);
        state.reconnectHandle = setTimeout(() => attemptIceRestart(), 4000);
      } else if (s === "failed") {
        setStatusLabel("Reconnecting…");
        attemptIceRestart();
      } else if (s === "closed") {
        stopStatsPolling();
      }
    };
  }

  async function attemptIceRestart() {
    if (!state.pc || state.role !== "caller" || state.status === "idle") return;
    try {
      const offer = await state.pc.createOffer({ iceRestart: true });
      await state.pc.setLocalDescription(offer);
      WS.send({
        event: "call_signal",
        call_id: state.callId,
        signal_type: "offer",
        payload: { type: offer.type, sdp: offer.sdp },
      });
    } catch (err) { /* fall through to the grace-timeout below */ }

    clearTimeout(state.reconnectHandle);
    state.reconnectHandle = setTimeout(() => {
      if (state.pc && (state.pc.connectionState === "failed" || state.pc.connectionState === "disconnected")) {
        UI.toast("Call dropped — connection lost", "error");
        endCall();
      }
    }, RECONNECT_GRACE_MS);
  }

  function flushPendingCandidates() {
    state.pendingCandidates.forEach((c) => {
      state.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    });
    state.pendingCandidates = [];
  }

  function startTimer() {
    state.startTime = Date.now();
    clearInterval(state.timerHandle);
    state.timerHandle = setInterval(() => {
      const secs = Math.floor((Date.now() - state.startTime) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, "0");
      const ss = String(secs % 60).padStart(2, "0");
      const timerEl = el("callTimer");
      if (timerEl) timerEl.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function setStatusLabel(text) {
    const lbl = el("callStatusLabel");
    if (lbl) lbl.textContent = text;
  }

  // Lightweight connection-quality indicator from RTCPeerConnection stats.
  function startStatsPolling() {
    stopStatsPolling();
    state.statsHandle = setInterval(async () => {
      if (!state.pc) return;
      try {
        const stats = await state.pc.getStats();
        let rtt = null, lossRatio = 0;
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime != null) {
            rtt = report.currentRoundTripTime;
          }
          if (report.type === "inbound-rtp" && !report.isRemote && report.packetsReceived) {
            const lost = report.packetsLost || 0;
            lossRatio = Math.max(lossRatio, lost / (lost + report.packetsReceived));
          }
        });
        const dot = el("callQualityDot");
        if (!dot) return;
        dot.classList.remove("quality-good", "quality-fair", "quality-poor");
        if (rtt == null && lossRatio === 0) dot.classList.add("quality-good");
        else if ((rtt != null && rtt > 0.4) || lossRatio > 0.08) dot.classList.add("quality-poor");
        else if ((rtt != null && rtt > 0.15) || lossRatio > 0.02) dot.classList.add("quality-fair");
        else dot.classList.add("quality-good");
      } catch (err) { /* ignore */ }
    }, STATS_POLL_MS);
  }
  function stopStatsPolling() {
    clearInterval(state.statsHandle);
  }

  // ---------------- UI ----------------
  function attachLocalPreview() {
    const localVideo = el("localVideo");
    localVideo.srcObject = state.localStream;
    localVideo.style.display = "block";
  }

  function showOutgoingUI() {
    el("outgoingCallAvatar").src = state.peerAvatar || avatarPlaceholder(state.peerUsername);
    el("outgoingCallName").textContent = state.peerUsername;
    el("outgoingCallStatus").textContent = `Calling… (${state.type === "video" ? "video" : "voice"})`;
    el("outgoingCallOverlay").style.display = "flex";
  }

  function showIncomingUI() {
    el("incomingCallAvatar").src = state.peerAvatar || avatarPlaceholder(state.peerUsername);
    el("incomingCallName").textContent = state.peerUsername;
    el("incomingCallType").textContent = `Incoming ${state.type === "video" ? "video" : "voice"} call…`;
    el("incomingCallOverlay").style.display = "flex";
  }

  function showActiveUI() {
    hideOverlay("outgoingCallOverlay");
    hideOverlay("incomingCallOverlay");
    el("activeCallAvatar").src = state.peerAvatar || avatarPlaceholder(state.peerUsername);
    el("activeCallName").textContent = state.peerUsername;
    el("callTimer").textContent = "00:00";
    setStatusLabel("Connecting…");
    el("callQualityDot").className = "call-quality-dot";
    el("callAudioView").style.display = state.type === "video" ? "none" : "flex";
    el("remoteVideo").style.display = state.type === "video" ? "block" : "none";
    el("localVideo").style.display = state.type === "video" ? "block" : "none";
    el("cameraToggleBtn").style.display = state.type === "video" ? "inline-flex" : "none";
    el("switchCameraBtn").style.display = state.type === "video" ? "inline-flex" : "none";
    el("fullscreenBtn").style.display = state.type === "video" ? "inline-flex" : "none";
    el("muteBtn").textContent = "🎤";
    el("muteBtn").classList.remove("active-danger");
    el("activeCallOverlay").style.display = "flex";
  }

  function hideOverlay(id) {
    const node = el(id);
    if (node) node.style.display = "none";
  }

  function avatarPlaceholder(name) {
    const initial = (name || "?").charAt(0).toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='100%' height='100%' rx='40' fill='%236C5CE7'/><text x='50%' y='58%' font-size='34' fill='white' text-anchor='middle' font-family='Poppins,sans-serif'>${initial}</text></svg>`;
    return `data:image/svg+xml,${svg}`;
  }

  function generateCallId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "call-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function resetState() {
    clearTimeout(state.ringTimeoutHandle);
    clearTimeout(state.reconnectHandle);
    clearInterval(state.timerHandle);
    stopStatsPolling();
    outgoingRing.stop();
    incomingRing.stop();

    if (state.pc) {
      state.pc.onicecandidate = null;
      state.pc.ontrack = null;
      state.pc.onconnectionstatechange = null;
      state.pc.close();
    }
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());

    hideOverlay("outgoingCallOverlay");
    hideOverlay("incomingCallOverlay");
    hideOverlay("activeCallOverlay");
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});

    const localVideo = el("localVideo");
    if (localVideo) { localVideo.srcObject = null; localVideo.style.display = "none"; }
    const remoteVideo = el("remoteVideo");
    if (remoteVideo) remoteVideo.srcObject = null;
    const remoteAudio = el("remoteAudio");
    if (remoteAudio) remoteAudio.srcObject = null;

    Object.assign(state, {
      callId: null, peerId: null, peerUsername: null, peerAvatar: null,
      role: null, status: "idle", pc: null, localStream: null, remoteStream: null,
      pendingCandidates: [], remoteOfferSdp: null, muted: false, cameraOff: false,
      startTime: null,
    });
  }

  // ---------------- WebSocket signalling ----------------
  function bindWebSocketEvents() {
    WS.on("call_invite", (data) => {
      if (state.status !== "idle") {
        // We're already on a call on this tab — let the server-side busy
        // check handle it (it won't even reach us in the common case);
        // defensively ignore here too.
        return;
      }
      state.role = "callee";
      state.callId = data.call_id;
      state.peerId = data.from_user_id;
      state.peerUsername = data.from_username;
      state.peerAvatar = data.from_avatar;
      state.activeChatId = data.chat_id;
      state.type = data.call_type === "video" ? "video" : "audio";
      state.remoteOfferSdp = data.sdp;
      state.status = "ringing-in";

      showIncomingUI();
      incomingRing.start();
      state.ringTimeoutHandle = setTimeout(() => {
        if (state.status === "ringing-in") {
          WS.send({ event: "call_reject", call_id: state.callId });
          resetState();
        }
      }, RING_TIMEOUT_MS);
    });

    WS.on("call_accept", async (data) => {
      if (data.call_id !== state.callId || state.role !== "caller") return;
      clearTimeout(state.ringTimeoutHandle);
      outgoingRing.stop();
      try {
        await state.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        flushPendingCandidates();
      } catch (err) {
        UI.toast("Call setup failed", "error");
        endCall();
        return;
      }
      state.status = "connecting";
      showActiveUI();
    });

    WS.on("call_reject", (data) => {
      if (data.call_id !== state.callId) return;
      UI.toast(`${state.peerUsername || "They"} declined the call`, "error");
      resetState();
    });

    WS.on("call_cancel", (data) => {
      if (data.call_id !== state.callId) return;
      UI.toast("Missed call", "error");
      resetState();
    });

    WS.on("call_busy", (data) => {
      if (data.call_id !== state.callId) return;
      UI.toast(`${state.peerUsername || "They"} is on another call`, "error");
      resetState();
    });

    WS.on("call_unavailable", (data) => {
      if (data.call_id !== state.callId) return;
      UI.toast(`${state.peerUsername || "They"} is unavailable right now`, "error");
      resetState();
    });

    WS.on("call_closed_elsewhere", (data) => {
      if (data.call_id !== state.callId) return;
      // Answered/declined on another of our own tabs/devices — just
      // dismiss the ringing UI here without sending any further signal.
      if (state.status === "ringing-in" || state.status === "ringing-out") {
        incomingRing.stop();
        outgoingRing.stop();
        resetState();
      }
    });

    WS.on("call_end", (data) => {
      if (data.call_id !== state.callId || state.status === "idle") return;
      const reason = data.reason === "peer_disconnected" ? `${state.peerUsername || "The other person"} disconnected` : "Call ended";
      UI.toast(reason, data.reason === "peer_disconnected" ? "error" : "success");
      resetState();
    });

    WS.on("call_signal", async (data) => {
      if (data.call_id !== state.callId) return;
      if (data.signal_type === "ice-candidate") {
        if (state.pc && state.pc.remoteDescription) {
          state.pc.addIceCandidate(new RTCIceCandidate(data.payload)).catch(() => {});
        } else {
          state.pendingCandidates.push(data.payload);
        }
      } else if (data.signal_type === "offer") {
        // Remote ICE-restart renegotiation
        try {
          await state.pc.setRemoteDescription(new RTCSessionDescription(data.payload));
          const answer = await state.pc.createAnswer();
          await state.pc.setLocalDescription(answer);
          WS.send({ event: "call_signal", call_id: state.callId, signal_type: "answer", payload: { type: answer.type, sdp: answer.sdp } });
        } catch (err) { /* ignore — connection state handling covers the fallback */ }
      } else if (data.signal_type === "answer") {
        try { await state.pc.setRemoteDescription(new RTCSessionDescription(data.payload)); } catch (err) { /* ignore */ }
      } else if (data.signal_type === "mute-state") {
        const badge = el("remotePeerMuted");
        if (badge) badge.style.display = data.payload && data.payload.muted ? "inline-flex" : "none";
      }
    });

    // Signalling socket hiccup during an active call: the peer-to-peer
    // media path is unaffected, just surface a small non-blocking hint.
    WS.on("disconnected", () => {
      if (state.status === "connected") setStatusLabel("Signal reconnecting…");
    });
    WS.on("connected", () => {
      if (state.status === "connected" && state.pc && state.pc.connectionState === "connected") setStatusLabel("Connected");
    });
  }

  function bindButtons() {
    el("acceptCallBtn").addEventListener("click", acceptCall);
    el("rejectCallBtn").addEventListener("click", rejectCall);
    el("cancelCallBtn").addEventListener("click", cancelCall);
    el("hangupBtn").addEventListener("click", endCall);
    el("muteBtn").addEventListener("click", toggleMute);
    el("cameraToggleBtn").addEventListener("click", toggleCamera);
    el("switchCameraBtn").addEventListener("click", switchCamera);
    el("fullscreenBtn").addEventListener("click", toggleFullscreen);
  }

  function init() {
    bindButtons();
    bindWebSocketEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
  // chat.js loads after this file and calls init synchronously via DOMContentLoaded;
  // if the DOM is already ready by the time this script runs, init immediately too.
  if (document.readyState !== "loading") init();

  return { setActivePeer, startCall, acceptCall, rejectCall, cancelCall, endCall, hangupIfActive };
})();
