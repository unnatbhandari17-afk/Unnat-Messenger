/**
 * Core application logic for the messenger UI: chat list, message
 * rendering, sending/editing/deleting/reacting, groups, profile,
 * settings, search, and wiring up realtime WebSocket events.
 */
(function () {
  if (!Api.getToken()) {
    window.location.href = "index.html";
    return;
  }

  // ---------------- STATE ----------------
  const state = {
    me: Api.getUser(),
    chats: [],
    currentChatId: null,
    messagesCache: {},      // chatId -> [messages]
    oldestLoaded: {},       // chatId -> oldest message id loaded
    hasMore: {},            // chatId -> bool
    typingTimers: {},       // chatId -> timeout for showing "typing"
    myTypingTimeout: null,
    replyTarget: null,
    pendingFile: null,
    activeFilter: "all",
    groupSelected: [],
    forwardMessageId: null,
    deleteTargetId: null,
    mediaRecorder: null,
    recordedChunks: [],
    isTypingActive: false,
  };

  const el = (id) => document.getElementById(id);

  // ---------------- THEME ----------------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    el("darkModeSwitch").checked = theme === "dark";
  }
  applyTheme(state.me?.theme || localStorage.getItem("nimbus_theme") || "light");

  el("darkModeSwitch").addEventListener("change", async (e) => {
    const theme = e.target.checked ? "dark" : "light";
    applyTheme(theme);
    localStorage.setItem("nimbus_theme", theme);
    try {
      const updated = await Api.put("/api/users/me", { theme });
      state.me = updated;
      Api.setUser(updated);
    } catch (err) { /* non-fatal */ }
  });

  // ---------------- INIT ----------------
  async function init() {
    try {
      state.me = await Api.get("/api/auth/me");
      Api.setUser(state.me);
    } catch (err) {
      window.location.href = "index.html";
      return;
    }
    renderMyProfile();
    WS.connect();
    bindWebSocketEvents();
    await loadChats();
    bindUI();

    // Restore notification preference
    el("notifSwitch").checked = localStorage.getItem("nimbus_notify") === "1";
  }

  function renderMyProfile() {
    el("myUsername").textContent = state.me.username;
    el("myAvatar").src = state.me.avatar_url || avatarPlaceholder(state.me.username);
    el("profileUsername").value = state.me.username;
    el("profileEmail").value = state.me.email;
    el("profileAbout").value = state.me.about || "";
    el("profileStatus").value = state.me.status_text || "";
    el("profileAvatar").src = state.me.avatar_url || avatarPlaceholder(state.me.username);
    el("profileCover").src = state.me.cover_url || "";
  }

  function avatarPlaceholder(name) {
    const initial = (name || "?").charAt(0).toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='100%' height='100%' rx='40' fill='%236C5CE7'/><text x='50%' y='58%' font-size='34' fill='white' text-anchor='middle' font-family='Poppins,sans-serif'>${initial}</text></svg>`;
    return `data:image/svg+xml,${svg}`;
  }

  // ---------------- CHAT LIST ----------------
  async function loadChats() {
    try {
      state.chats = await Api.get("/api/chats");
    } catch (err) {
      UI.toast(err.message, "error");
      state.chats = [];
    }
    renderChatList();
  }

  function renderChatList() {
    const container = el("chatList");
    let list = state.chats.slice();

    if (state.activeFilter === "unread") list = list.filter((c) => c.unread_count > 0 && !c.is_archived);
    else if (state.activeFilter === "pinned") list = list.filter((c) => c.is_pinned && !c.is_archived);
    else if (state.activeFilter === "archived") list = list.filter((c) => c.is_archived);
    else if (state.activeFilter === "groups") list = list.filter((c) => c.type === "group" && !c.is_archived);
    else list = list.filter((c) => !c.is_archived);

    if (list.length === 0) {
      container.innerHTML = `<div class="empty-state">No conversations here yet.<br>Tap ✏️ to start one.</div>`;
      return;
    }

    container.innerHTML = "";
    list.forEach((chat) => {
      const item = document.createElement("div");
      item.className = "chat-item" + (chat.id === state.currentChatId ? " active" : "");
      const otherOnline = chat.type === "direct" && chat.members.some((m) => m.id !== state.me.id && m.is_online);
      item.innerHTML = `
        <div class="avatar-wrap">
          <img class="avatar avatar-sm" src="${chat.icon_url || avatarPlaceholder(chat.name)}">
          ${otherOnline ? '<span class="online-dot"></span>' : ""}
        </div>
        <div class="chat-item-body">
          <div class="chat-item-top">
            <span class="chat-item-name">${chat.is_pinned ? '<span class="pin-icon">📌</span>' : ""}${UI.escapeHtml(chat.name || "Unnamed")}</span>
            <span class="chat-item-time">${chat.last_message_at ? UI.formatRelative(chat.last_message_at) : ""}</span>
          </div>
          <div class="chat-item-preview">
            <p>${chat.last_message ? UI.escapeHtml(chat.last_message) : "No messages yet"}</p>
            ${chat.unread_count > 0 ? `<span class="unread-badge">${chat.unread_count}</span>` : ""}
          </div>
        </div>`;
      item.addEventListener("click", () => selectChat(chat.id));
      container.appendChild(item);
    });
  }

  el("searchInput").addEventListener("input", debounce(async (e) => {
    const q = e.target.value.trim();
    if (!q) { renderChatList(); return; }
    // Local filter over chat names + a global message/user search hint
    const container = el("chatList");
    const filtered = state.chats.filter((c) => (c.name || "").toLowerCase().includes(q.toLowerCase()));
    container.innerHTML = "";
    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state">No chats match "${UI.escapeHtml(q)}"</div>`;
    } else {
      filtered.forEach((chat) => {
        const item = document.createElement("div");
        item.className = "chat-item";
        item.innerHTML = `<div class="avatar-wrap"><img class="avatar avatar-sm" src="${chat.icon_url || avatarPlaceholder(chat.name)}"></div>
          <div class="chat-item-body"><div class="chat-item-name">${UI.escapeHtml(chat.name)}</div></div>`;
        item.addEventListener("click", () => selectChat(chat.id));
        container.appendChild(item);
      });
    }
  }, 250));

  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.activeFilter = chip.dataset.filter;
      renderChatList();
    });
  });

  // ---------------- SELECT CHAT ----------------
  async function selectChat(chatId) {
    state.currentChatId = chatId;
    state.replyTarget = null;
    el("replyPreview").style.display = "none";
    el("noChatSelected").style.display = "none";
    el("activeChat").style.display = "flex";
    document.getElementById("sidebar").classList.add("chat-open"); // mobile

    renderChatList();
    const chat = state.chats.find((c) => c.id === chatId);
    if (chat) renderChatHeader(chat);

    if (!state.messagesCache[chatId]) {
      state.messagesCache[chatId] = [];
      state.hasMore[chatId] = true;
      await fetchMessages(chatId);
    } else {
      renderMessages(chatId);
    }

    try {
      await Api.put(`/api/chats/${chatId}/read`, {});
      const c = state.chats.find((c) => c.id === chatId);
      if (c) c.unread_count = 0;
      renderChatList();
    } catch (e) { /* ignore */ }
  }

  function renderChatHeader(chat) {
    el("chatTitle").textContent = chat.name || "Unnamed";
    el("chatAvatar").src = chat.icon_url || avatarPlaceholder(chat.name);
    if (chat.type === "direct") {
      const other = chat.members.find((m) => m.id !== state.me.id);
      el("chatSubtitle").textContent = other ? (other.is_online ? "Active now" : UI.lastSeenLabel(other.last_seen)) : "";
      // Voice/video calling is one-to-one only — wire the header call
      // buttons to whichever direct-chat peer is currently open.
      if (other && window.Calls) {
        Calls.setActivePeer({ id: other.id, username: other.username, avatar_url: other.avatar_url }, chat.id);
      }
      el("voiceCallBtn").style.display = "inline-flex";
      el("videoCallBtn").style.display = "inline-flex";
    } else {
      el("chatSubtitle").textContent = `${chat.members.length} members`;
      el("voiceCallBtn").style.display = "none";
      el("videoCallBtn").style.display = "none";
      if (window.Calls) Calls.setActivePeer(null, null);
    }
  }

  async function fetchMessages(chatId, beforeId) {
    let url = `/api/messages/${chatId}?limit=30`;
    if (beforeId) url += `&before_id=${beforeId}`;
    let msgs;
    try {
      msgs = await Api.get(url);
    } catch (err) {
      UI.toast(err.message, "error");
      return;
    }
    if (msgs.length < 30) state.hasMore[chatId] = false;
    if (msgs.length > 0) state.oldestLoaded[chatId] = msgs[0].id;

    state.messagesCache[chatId] = beforeId ? [...msgs, ...state.messagesCache[chatId]] : msgs;
    renderMessages(chatId, beforeId ? msgs.length : null);
  }

  function renderMessages(chatId, prependCount) {
    if (chatId !== state.currentChatId) return;
    const list = el("messagesList");
    const container = el("messagesContainer");
    const msgs = state.messagesCache[chatId] || [];

    el("loadMoreBtn").style.display = state.hasMore[chatId] ? "inline-block" : "none";

    const prevScrollHeight = container.scrollHeight;
    list.innerHTML = "";
    let lastDay = null;
    msgs.forEach((m) => {
      const day = UI.formatDay(m.created_at);
      if (day !== lastDay) {
        const divider = document.createElement("div");
        divider.className = "day-divider";
        divider.innerHTML = `<span>${day}</span>`;
        list.appendChild(divider);
        lastDay = day;
      }
      list.appendChild(renderMessageRow(m, chatId));
    });

    if (prependCount) {
      container.scrollTop = container.scrollHeight - prevScrollHeight;
    } else {
      container.scrollTop = container.scrollHeight;
    }
  }

  function findMessage(chatId, id) {
    return (state.messagesCache[chatId] || []).find((m) => m.id === id);
  }

  function renderMessageRow(m, chatId) {
    const row = document.createElement("div");
    const isMine = m.sender_id === state.me.id;
    row.className = "msg-row " + (isMine ? "sent" : "received");
    row.dataset.id = m.id;

    const avatar = `<img class="avatar avatar-sm" src="${m.sender_avatar || avatarPlaceholder(m.sender_username)}">`;

    let replyHtml = "";
    if (m.reply_to_id) {
      const original = findMessage(chatId, m.reply_to_id);
      replyHtml = `<div class="bubble-reply">${original ? UI.escapeHtml((original.content || "Attachment").slice(0, 80)) : "Original message"}</div>`;
    }

    let attachHtml = "";
    (m.attachments || []).forEach((a) => {
      if (a.file_type === "image") {
        attachHtml += `<div class="attachment-bubble"><img src="${a.file_path}" data-lightbox="${a.file_path}"></div>`;
      } else if (a.file_type === "video") {
        attachHtml += `<div class="attachment-bubble"><video src="${a.file_path}" controls></video></div>`;
      } else if (a.file_type === "audio") {
        attachHtml += `<audio src="${a.file_path}" controls style="max-width:240px;"></audio>`;
      } else {
        attachHtml += `<a class="attachment-file" href="${a.file_path}" download="${a.file_name}"><span class="file-icon">📄</span><span><div>${UI.escapeHtml(a.file_name)}</div><div class="file-meta">${(a.file_size / 1024).toFixed(1)} KB</div></span></a>`;
      }
    });

    const bodyText = m.is_deleted_for_everyone
      ? `<span class="bubble deleted">🚫 This message was deleted</span>`
      : (m.content ? `<div class="bubble">${replyHtml}${UI.escapeHtml(m.content)}</div>` : (attachHtml ? "" : `<div class="bubble"></div>`));

    let reactionsHtml = "";
    if (m.reactions && m.reactions.length) {
      const counts = {};
      m.reactions.forEach((r) => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
      reactionsHtml = `<div class="reactions-row">${Object.entries(counts).map(([emoji, count]) => `<span class="reaction-chip" data-emoji="${emoji}">${emoji} ${count > 1 ? count : ""}</span>`).join("")}</div>`;
    }

    let receiptHtml = "";
    if (isMine && !m.is_deleted_for_everyone) {
      receiptHtml = `<span class="read-receipt ${m.status === "seen" ? "seen" : ""}">${m.status === "seen" ? "✓✓ Seen" : m.status === "delivered" ? "✓✓" : "✓ Sent"}</span>`;
    }

    row.innerHTML = `
      ${avatar}
      <div class="bubble-col">
        ${attachHtml}
        ${bodyText}
        ${reactionsHtml}
        <div class="msg-meta">
          <span>${UI.formatTime(m.created_at)}</span>
          ${m.is_edited ? '<span class="edited-tag">· edited</span>' : ""}
          ${receiptHtml}
        </div>
      </div>
      <div class="msg-actions">
        <button data-action="react" title="React">😊</button>
        <button data-action="reply" title="Reply">↩️</button>
        <button data-action="forward" title="Forward">➡️</button>
        ${isMine ? '<button data-action="edit" title="Edit">✏️</button>' : ""}
        <button data-action="delete" title="Delete">🗑️</button>
      </div>`;

    row.querySelectorAll("[data-lightbox]").forEach((img) => {
      img.addEventListener("click", () => {
        const lb = el("lightboxImg");
        lb.src = img.dataset.lightbox;
        lb.style.display = "block";
        lb.onclick = () => (lb.style.display = "none");
      });
    });

    row.querySelectorAll(".reaction-chip").forEach((chip) => {
      chip.addEventListener("click", () => reactToMessage(m.id, chip.dataset.emoji));
    });

    row.querySelector('[data-action="reply"]').addEventListener("click", () => startReply(m));
    row.querySelector('[data-action="forward"]').addEventListener("click", () => openForwardModal(m.id));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => openDeleteConfirm(m.id, isMine));
    const editBtn = row.querySelector('[data-action="edit"]');
    if (editBtn) editBtn.addEventListener("click", () => startEdit(m));
    row.querySelector('[data-action="react"]').addEventListener("click", (e) => showReactionPicker(e.currentTarget, m.id));

    return row;
  }

  function showReactionPicker(anchor, messageId) {
    document.querySelectorAll(".reaction-picker-popup").forEach((p) => p.remove());
    const popup = document.createElement("div");
    popup.className = "reaction-picker-popup";
    UI.QUICK_REACTIONS.forEach((emoji) => {
      const span = document.createElement("span");
      span.textContent = emoji;
      span.addEventListener("click", () => { reactToMessage(messageId, emoji); popup.remove(); });
      popup.appendChild(span);
    });
    anchor.closest(".msg-actions").appendChild(popup);
    setTimeout(() => document.addEventListener("click", function handler(ev) {
      if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener("click", handler); }
    }), 10);
  }

  async function reactToMessage(messageId, emoji) {
    try {
      const updated = await Api.post(`/api/messages/${messageId}/reactions`, { emoji });
      updateCachedMessage(updated);
    } catch (err) { UI.toast(err.message, "error"); }
  }

  function updateCachedMessage(updated) {
    const arr = state.messagesCache[updated.chat_id];
    if (!arr) return;
    const idx = arr.findIndex((m) => m.id === updated.id);
    if (idx >= 0) arr[idx] = updated;
    if (updated.chat_id === state.currentChatId) renderMessages(updated.chat_id);
  }

  // Insert-or-replace by message id. Used everywhere a message can arrive
  // from more than one place (optimistic local update after sending, and
  // the WebSocket broadcast of that same message — which now also reaches
  // the sending tab's own other devices/tabs) so we never end up with two
  // copies of the same message in the list.
  function upsertMessage(chatId, msg) {
    const arr = state.messagesCache[chatId] || (state.messagesCache[chatId] = []);
    const idx = arr.findIndex((m) => m.id === msg.id);
    if (idx >= 0) arr[idx] = msg;
    else arr.push(msg);
    if (chatId === state.currentChatId) renderMessages(chatId);
    return arr;
  }

  function startReply(m) {
    state.replyTarget = m;
    el("replyToName").textContent = m.sender_id === state.me.id ? "yourself" : m.sender_username;
    el("replyToText").textContent = m.content || "Attachment";
    el("replyPreview").style.display = "flex";
    el("messageInput").focus();
  }
  el("cancelReply").addEventListener("click", () => {
    state.replyTarget = null;
    el("replyPreview").style.display = "none";
  });

  function startEdit(m) {
    const input = el("messageInput");
    input.value = m.content || "";
    input.focus();
    input.dataset.editingId = m.id;
    UI.toast("Editing message — press Enter to save", "success");
  }

  function openDeleteConfirm(messageId, isMine) {
    state.deleteTargetId = messageId;
    el("deleteForEveryoneBtn").style.display = isMine ? "inline-block" : "none";
    UI.openModal("deleteConfirmModal");
  }
  el("deleteForMeBtn").addEventListener("click", () => doDelete(false));
  el("deleteForEveryoneBtn").addEventListener("click", () => doDelete(true));

  async function doDelete(forEveryone) {
    const id = state.deleteTargetId;
    UI.closeModal("deleteConfirmModal");
    try {
      await Api.request("DELETE", `/api/messages/${id}?for_everyone=${forEveryone}`);
      const arr = state.messagesCache[state.currentChatId] || [];
      if (forEveryone) {
        const msg = arr.find((m) => m.id === id);
        if (msg) { msg.is_deleted_for_everyone = true; msg.content = null; msg.attachments = []; }
      } else {
        const idx = arr.findIndex((m) => m.id === id);
        if (idx >= 0) arr.splice(idx, 1);
      }
      renderMessages(state.currentChatId);
    } catch (err) { UI.toast(err.message, "error"); }
  }

  function openForwardModal(messageId) {
    state.forwardMessageId = messageId;
    const list = el("forwardChatList");
    list.innerHTML = "";
    state.chats.forEach((chat) => {
      const item = document.createElement("div");
      item.className = "result-item";
      item.innerHTML = `<img class="avatar avatar-sm" src="${chat.icon_url || avatarPlaceholder(chat.name)}"><div><div class="name">${UI.escapeHtml(chat.name)}</div></div>`;
      item.addEventListener("click", async () => {
        try {
          await Api.post("/api/messages", { chat_id: chat.id, forwarded_from_id: messageId, content: findMessage(state.currentChatId, messageId)?.content || "Forwarded message" });
          UI.toast("Message forwarded", "success");
          UI.closeModal("forwardModal");
        } catch (err) { UI.toast(err.message, "error"); }
      });
      list.appendChild(item);
    });
    UI.openModal("forwardModal");
  }

  // ---------------- SENDING ----------------
  el("messageForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await sendCurrentMessage();
  });

  const messageInput = el("messageInput");
  messageInput.addEventListener("input", () => {
    if (!state.currentChatId) return;
    // Only send the "typing" event once per typing burst — not on every
    // keystroke — to keep the socket traffic minimal. We only re-announce
    // once stop_typing has fired (inactivity) and the person starts again.
    if (!state.isTypingActive) {
      state.isTypingActive = true;
      WS.send({ event: "typing", chat_id: state.currentChatId });
    }
    clearTimeout(state.myTypingTimeout);
    state.myTypingTimeout = setTimeout(() => {
      state.isTypingActive = false;
      WS.send({ event: "stop_typing", chat_id: state.currentChatId });
    }, 2500);
  });

  async function sendCurrentMessage() {
    const input = el("messageInput");
    const text = input.value.trim();
    const editingId = input.dataset.editingId;

    if (editingId) {
      if (!text) return;
      try {
        const updated = await Api.put(`/api/messages/${editingId}`, { content: text });
        updateCachedMessage(updated);
      } catch (err) { UI.toast(err.message, "error"); }
      delete input.dataset.editingId;
      input.value = "";
      return;
    }

    if (!text && !state.pendingFile) return;
    if (!state.currentChatId) return;

    const payload = { chat_id: state.currentChatId, content: text || null };
    if (state.replyTarget) payload.reply_to_id = state.replyTarget.id;

    input.value = "";
    const fileToSend = state.pendingFile;
    clearAttachmentPreview();
    const wasReplying = state.replyTarget;
    state.replyTarget = null;
    el("replyPreview").style.display = "none";
    clearTimeout(state.myTypingTimeout);
    state.isTypingActive = false;
    WS.send({ event: "stop_typing", chat_id: state.currentChatId });

    try {
      const msg = await Api.post("/api/messages", payload);
      upsertMessage(state.currentChatId, msg);
      bumpChatPreview(state.currentChatId, msg);
      if (fileToSend) {
        const form = new FormData();
        form.append("file", fileToSend);
        const attachment = await Api.postForm(`/api/uploads/attachment/${msg.id}`, form);
        const finalMsg = { ...msg, attachments: [attachment] };
        upsertMessage(state.currentChatId, finalMsg);
        bumpChatPreview(state.currentChatId, finalMsg);
      }
    } catch (err) {
      UI.toast(err.message, "error");
    }
  }

  function bumpChatPreview(chatId, msg) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (chat) {
      chat.last_message = msg.content || (msg.attachments?.length ? "📎 Attachment" : "");
      chat.last_message_at = msg.created_at;
    }
    renderChatList();
  }

  // ---------------- ATTACHMENTS ----------------
  el("attachBtn").addEventListener("click", () => el("fileInput").click());
  el("fileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { UI.toast("File exceeds 25 MB limit", "error"); return; }
    state.pendingFile = file;
    showAttachmentPreview(file);
  });

  function showAttachmentPreview(file) {
    const preview = el("attachmentPreview");
    preview.style.display = "flex";
    const isImage = file.type.startsWith("image/");
    preview.innerHTML = `
      ${isImage ? `<img src="${URL.createObjectURL(file)}">` : `<span>📄</span>`}
      <span>${UI.escapeHtml(file.name)}</span>
      <button class="remove-attach" id="removeAttachBtn">✕ Remove</button>`;
    el("removeAttachBtn").addEventListener("click", clearAttachmentPreview);
  }
  function clearAttachmentPreview() {
    state.pendingFile = null;
    el("attachmentPreview").style.display = "none";
    el("attachmentPreview").innerHTML = "";
    el("fileInput").value = "";
  }

  // Drag & drop onto the message area
  el("messagesContainer").addEventListener("dragover", (e) => e.preventDefault());
  el("messagesContainer").addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      if (file.size > 25 * 1024 * 1024) { UI.toast("File exceeds 25 MB limit", "error"); return; }
      state.pendingFile = file;
      showAttachmentPreview(file);
    }
  });
  // Clipboard paste
  el("messageInput").addEventListener("paste", (e) => {
    const item = Array.from(e.clipboardData.items || []).find((i) => i.type.startsWith("image/"));
    if (item) {
      const file = item.getAsFile();
      state.pendingFile = file;
      showAttachmentPreview(file);
    }
  });

  // ---------------- VOICE MESSAGES ----------------
  const micBtn = el("micBtn");
  let recordingStart = null;

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.recordedChunks = [];
      state.mediaRecorder = new MediaRecorder(stream);
      state.mediaRecorder.ondataavailable = (e) => state.recordedChunks.push(e.data);
      state.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(state.recordedChunks, { type: "audio/webm" });
        if (blob.size < 500) return; // ignore accidental taps
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });
        if (!state.currentChatId) return;
        try {
          const msg = await Api.post("/api/messages", { chat_id: state.currentChatId, content: null });
          upsertMessage(state.currentChatId, msg);
          const form = new FormData();
          form.append("file", file);
          const attachment = await Api.postForm(`/api/uploads/attachment/${msg.id}`, form);
          const finalMsg = { ...msg, attachments: [attachment] };
          upsertMessage(state.currentChatId, finalMsg);
          bumpChatPreview(state.currentChatId, finalMsg);
        } catch (err) { UI.toast(err.message, "error"); }
      };
      state.mediaRecorder.start();
      micBtn.classList.add("mic-recording");
      micBtn.textContent = "⏺️";
    } catch (err) {
      UI.toast("Microphone access denied or unavailable", "error");
    }
  }
  function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
    micBtn.classList.remove("mic-recording");
    micBtn.textContent = "🎤";
  }
  micBtn.addEventListener("mousedown", startRecording);
  micBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); });
  micBtn.addEventListener("mouseup", stopRecording);
  micBtn.addEventListener("mouseleave", () => { if (state.mediaRecorder && state.mediaRecorder.state === "recording") stopRecording(); });
  micBtn.addEventListener("touchend", stopRecording);

  // ---------------- EMOJI PICKER ----------------
  const emojiPicker = el("emojiPicker");
  UI.EMOJIS.forEach((emoji) => {
    const span = document.createElement("span");
    span.textContent = emoji;
    span.addEventListener("click", () => { messageInput.value += emoji; messageInput.focus(); });
    emojiPicker.appendChild(span);
  });
  el("emojiBtn").addEventListener("click", () => {
    emojiPicker.style.display = emojiPicker.style.display === "none" ? "flex" : "none";
  });
  document.addEventListener("click", (e) => {
    if (!emojiPicker.contains(e.target) && e.target !== el("emojiBtn")) emojiPicker.style.display = "none";
  });

  // ---------------- INFINITE SCROLL ----------------
  el("loadMoreBtn").addEventListener("click", () => {
    if (state.currentChatId && state.oldestLoaded[state.currentChatId]) {
      fetchMessages(state.currentChatId, state.oldestLoaded[state.currentChatId]);
    }
  });
  el("messagesContainer").addEventListener("scroll", (e) => {
    if (e.target.scrollTop < 60 && state.hasMore[state.currentChatId]) {
      fetchMessages(state.currentChatId, state.oldestLoaded[state.currentChatId]);
    }
  });

  // ---------------- IN-CHAT SEARCH ----------------
  el("chatSearchBtn").addEventListener("click", () => {
    el("inChatSearch").style.display = "flex";
    el("inChatSearchInput").focus();
  });
  el("closeInChatSearch").addEventListener("click", () => {
    el("inChatSearch").style.display = "none";
    renderMessages(state.currentChatId);
  });
  el("inChatSearchInput").addEventListener("input", debounce(async (e) => {
    const q = e.target.value.trim();
    if (!q || !state.currentChatId) return;
    try {
      const results = await Api.get(`/api/messages/search/${state.currentChatId}?q=${encodeURIComponent(q)}`);
      const list = el("messagesList");
      list.innerHTML = results.length
        ? results.map((m) => `<div class="msg-row received"><div class="bubble-col"><div class="bubble">${UI.escapeHtml(m.content || "")}<br><small style="opacity:.6">${UI.formatDay(m.created_at)} ${UI.formatTime(m.created_at)}</small></div></div></div>`).join("")
        : `<div class="empty-state">No messages match "${UI.escapeHtml(q)}"</div>`;
    } catch (err) { UI.toast(err.message, "error"); }
  }, 300));

  // ---------------- NEW CHAT ----------------
  el("newChatBtn").addEventListener("click", () => { el("userSearchInput").value = ""; el("userSearchResults").innerHTML = ""; UI.openModal("newChatModal"); });
  el("userSearchInput").addEventListener("input", debounce(async (e) => {
    const q = e.target.value.trim();
    const results = el("userSearchResults");
    if (!q) { results.innerHTML = ""; return; }
    try {
      const users = await Api.get(`/api/users/search?q=${encodeURIComponent(q)}`);
      results.innerHTML = "";
      users.forEach((u) => {
        const item = document.createElement("div");
        item.className = "result-item";
        item.innerHTML = `<img class="avatar avatar-sm" src="${u.avatar_url || avatarPlaceholder(u.username)}"><div><div class="name">${UI.escapeHtml(u.username)}</div><div class="sub">${u.is_online ? "Active now" : UI.lastSeenLabel(u.last_seen)}</div></div>`;
        item.addEventListener("click", async () => {
          try {
            const chat = await Api.post("/api/chats", { type: "direct", member_ids: [u.id] });
            UI.closeModal("newChatModal");
            await loadChats();
            selectChat(chat.id);
          } catch (err) { UI.toast(err.message, "error"); }
        });
        results.appendChild(item);
      });
    } catch (err) { UI.toast(err.message, "error"); }
  }, 300));

  // ---------------- NEW GROUP ----------------
  el("newGroupBtn").addEventListener("click", () => {
    el("groupNameInput").value = "";
    el("groupDescInput").value = "";
    el("groupMemberSearch").value = "";
    el("groupMemberResults").innerHTML = "";
    state.groupSelected = [];
    renderGroupChips();
    UI.openModal("newGroupModal");
  });
  el("groupMemberSearch").addEventListener("input", debounce(async (e) => {
    const q = e.target.value.trim();
    const results = el("groupMemberResults");
    if (!q) { results.innerHTML = ""; return; }
    try {
      const users = await Api.get(`/api/users/search?q=${encodeURIComponent(q)}`);
      results.innerHTML = "";
      users.filter((u) => !state.groupSelected.some((s) => s.id === u.id)).forEach((u) => {
        const item = document.createElement("div");
        item.className = "result-item";
        item.innerHTML = `<img class="avatar avatar-sm" src="${u.avatar_url || avatarPlaceholder(u.username)}"><div class="name">${UI.escapeHtml(u.username)}</div>`;
        item.addEventListener("click", () => { state.groupSelected.push(u); renderGroupChips(); results.innerHTML = ""; el("groupMemberSearch").value = ""; });
        results.appendChild(item);
      });
    } catch (err) { UI.toast(err.message, "error"); }
  }, 300));
  function renderGroupChips() {
    el("groupSelectedMembers").innerHTML = state.groupSelected.map((u) => `<span class="chip">${UI.escapeHtml(u.username)}<button data-id="${u.id}">✕</button></span>`).join("");
    el("groupSelectedMembers").querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.groupSelected = state.groupSelected.filter((u) => u.id != btn.dataset.id);
        renderGroupChips();
      });
    });
  }
  el("createGroupBtn").addEventListener("click", async () => {
    const name = el("groupNameInput").value.trim();
    if (!name) { UI.toast("Group name is required", "error"); return; }
    if (state.groupSelected.length === 0) { UI.toast("Add at least one member", "error"); return; }
    try {
      const chat = await Api.post("/api/chats", {
        type: "group", name, description: el("groupDescInput").value.trim(),
        member_ids: state.groupSelected.map((u) => u.id),
      });
      UI.closeModal("newGroupModal");
      await loadChats();
      selectChat(chat.id);
    } catch (err) { UI.toast(err.message, "error"); }
  });

  // ---------------- CHAT INFO / GROUP MANAGEMENT ----------------
  el("chatInfoBtn").addEventListener("click", () => renderChatInfo());
  el("chatHeaderInfo").addEventListener("click", () => renderChatInfo());

  function renderChatInfo() {
    const chat = state.chats.find((c) => c.id === state.currentChatId);
    if (!chat) return;
    el("chatInfoTitle").textContent = chat.type === "group" ? "Group Info" : "Contact Info";
    const myMembership = chat.members.find((m) => m.id === state.me.id);
    const body = el("chatInfoBody");

    let membersHtml = chat.members.map((m) => `
      <div class="result-item">
        <img class="avatar avatar-sm" src="${m.avatar_url || avatarPlaceholder(m.username)}">
        <div style="flex:1"><div class="name">${UI.escapeHtml(m.username)}</div><div class="sub">${m.is_online ? "Active now" : UI.lastSeenLabel(m.last_seen)}</div></div>
        ${chat.type === "group" && m.id !== state.me.id ? `<button class="btn-ghost small" data-remove="${m.id}">Remove</button>` : ""}
      </div>`).join("");

    body.innerHTML = `
      <div style="text-align:center;margin-bottom:16px;">
        <img class="avatar avatar-lg" src="${chat.icon_url || avatarPlaceholder(chat.name)}">
        <h3 style="margin-top:8px;">${UI.escapeHtml(chat.name)}</h3>
        ${chat.description ? `<p class="muted">${UI.escapeHtml(chat.description)}</p>` : ""}
      </div>
      <div class="settings-row clickable" id="pinToggleBtn"><span>${chat.is_pinned ? "Unpin chat" : "Pin chat"}</span><span class="chevron">›</span></div>
      <div class="settings-row clickable" id="archiveToggleBtn"><span>${chat.is_archived ? "Unarchive" : "Archive chat"}</span><span class="chevron">›</span></div>
      ${chat.type === "group" ? `<div class="settings-row clickable" id="leaveGroupBtn"><span class="danger-text">Leave group</span><span class="chevron">›</span></div>` : ""}
      <h4 style="margin-top:14px;">Members</h4>
      ${membersHtml}
    `;

    el("pinToggleBtn").addEventListener("click", async () => { await Api.put(`/api/chats/${chat.id}/pin`, {}); await loadChats(); renderChatInfo(); });
    el("archiveToggleBtn").addEventListener("click", async () => { await Api.put(`/api/chats/${chat.id}/archive`, {}); await loadChats(); UI.closeModal("chatInfoModal"); });
    const leaveBtn = el("leaveGroupBtn");
    if (leaveBtn) leaveBtn.addEventListener("click", async () => {
      await Api.del(`/api/chats/${chat.id}/members/${state.me.id}`);
      UI.closeModal("chatInfoModal");
      state.currentChatId = null;
      el("activeChat").style.display = "none";
      el("noChatSelected").style.display = "flex";
      await loadChats();
    });
    body.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await Api.del(`/api/chats/${chat.id}/members/${btn.dataset.remove}`);
          await loadChats();
          renderChatInfo();
        } catch (err) { UI.toast(err.message, "error"); }
      });
    });

    UI.openModal("chatInfoModal");
  }

  // ---------------- PROFILE ----------------
  el("myProfileBtn").addEventListener("click", () => UI.openModal("profileModal"));
  el("myProfileSettingsBtn").addEventListener("click", () => { UI.closeModal("settingsModal"); UI.openModal("profileModal"); });
  el("saveProfileBtn").addEventListener("click", async () => {
    try {
      const updated = await Api.put("/api/users/me", { about: el("profileAbout").value, status_text: el("profileStatus").value });
      state.me = updated;
      Api.setUser(updated);
      el("profileMsg").textContent = "Profile updated!";
      renderMyProfile();
    } catch (err) { UI.toast(err.message, "error"); }
  });
  el("changePasswordBtn").addEventListener("click", async () => {
    try {
      await Api.put("/api/users/me/password", { old_password: el("oldPassword").value, new_password: el("newPassword").value });
      el("profileMsg").textContent = "Password updated!";
      el("oldPassword").value = ""; el("newPassword").value = "";
    } catch (err) { UI.toast(err.message, "error"); }
  });
  el("avatarUploadBtn").addEventListener("click", () => el("avatarInput").click());
  el("avatarInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData(); form.append("file", file);
    try {
      const res = await Api.postForm("/api/uploads/avatar", form);
      state.me.avatar_url = res.avatar_url;
      Api.setUser(state.me);
      renderMyProfile();
      UI.toast("Profile picture updated", "success");
    } catch (err) { UI.toast(err.message, "error"); }
  });
  el("coverUploadBtn").addEventListener("click", () => el("coverInput").click());
  el("coverInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData(); form.append("file", file);
    try {
      const res = await Api.postForm("/api/uploads/cover", form);
      state.me.cover_url = res.cover_url;
      Api.setUser(state.me);
      renderMyProfile();
    } catch (err) { UI.toast(err.message, "error"); }
  });

  // ---------------- SETTINGS ----------------
  el("settingsBtn").addEventListener("click", () => UI.openModal("settingsModal"));
  el("notifSwitch").addEventListener("change", async (e) => {
    if (e.target.checked) {
      if (Notification.permission !== "granted") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") { e.target.checked = false; return; }
      }
      localStorage.setItem("nimbus_notify", "1");
    } else {
      localStorage.setItem("nimbus_notify", "0");
    }
  });
  el("logoutBtn").addEventListener("click", async () => {
    if (window.Calls) Calls.hangupIfActive();
    try { await Api.post("/api/auth/logout", {}); } catch (e) {}
    WS.disconnect();
    Api.clearToken();
    localStorage.removeItem("nimbus_user");
    window.location.href = "index.html";
  });
  el("blockedUsersBtn").addEventListener("click", async () => {
    UI.closeModal("settingsModal");
    const list = el("blockedList");
    list.innerHTML = "Loading…";
    try {
      const blocked = await Api.get("/api/users/me/blocked");
      list.innerHTML = blocked.length ? "" : `<div class="empty-state">No blocked users</div>`;
      blocked.forEach((u) => {
        const item = document.createElement("div");
        item.className = "result-item";
        item.innerHTML = `<img class="avatar avatar-sm" src="${u.avatar_url || avatarPlaceholder(u.username)}"><div style="flex:1" class="name">${UI.escapeHtml(u.username)}</div><button class="btn-ghost small" data-unblock="${u.id}">Unblock</button>`;
        list.appendChild(item);
      });
      list.querySelectorAll("[data-unblock]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await Api.post("/api/users/unblock", { user_id: parseInt(btn.dataset.unblock) });
          btn.closest(".result-item").remove();
        });
      });
    } catch (err) { UI.toast(err.message, "error"); }
    UI.openModal("blockedModal");
  });

  // ---------------- WEBSOCKET EVENTS ----------------
  function bindWebSocketEvents() {
    WS.on("new_message", (data) => {
      const m = data.message;
      // Only treat this as a brand-new arrival (bump unread / notify) the
      // first time we see this id — our own sending tab may already have
      // added it optimistically, and the server now echoes new_message to
      // all of the sender's own connections too (for multi-tab/device sync).
      const existingArr = state.messagesCache[m.chat_id];
      const isNewToUs = !existingArr || !existingArr.some((x) => x.id === m.id);

      if (state.messagesCache[m.chat_id]) {
        upsertMessage(m.chat_id, m);
        if (m.chat_id === state.currentChatId) {
          Api.put(`/api/chats/${m.chat_id}/read`, {}).catch(() => {});
        }
      }
      const chat = state.chats.find((c) => c.id === m.chat_id);
      if (chat) {
        chat.last_message = m.content || "📎 Attachment";
        chat.last_message_at = m.created_at;
        if (isNewToUs && m.sender_id !== state.me.id && m.chat_id !== state.currentChatId) {
          chat.unread_count = (chat.unread_count || 0) + 1;
        }
      }
      renderChatList();
      if (isNewToUs && m.sender_id !== state.me.id) notifyIfEnabled(m);
    });

    // A message that was just sent now has its attachment attached (voice
    // notes, images, videos, files) — update it in place so it appears
    // instantly for every chat member without anyone needing to refresh.
    WS.on("message_attachment", (data) => {
      const m = data.message;
      if (state.messagesCache[m.chat_id]) upsertMessage(m.chat_id, m);
      const chat = state.chats.find((c) => c.id === m.chat_id);
      if (chat && (chat.last_message_at == null || new Date(m.created_at) >= new Date(chat.last_message_at))) {
        chat.last_message = m.content || "📎 Attachment";
        chat.last_message_at = m.created_at;
        renderChatList();
      }
    });

    WS.on("message_edited", (data) => updateCachedMessage(data.message));
    WS.on("message_reaction", (data) => updateCachedMessage(data.message));

    WS.on("message_deleted", (data) => {
      Object.values(state.messagesCache).forEach((arr) => {
        const msg = arr.find((m) => m.id === data.message_id);
        if (msg && data.for_everyone) { msg.is_deleted_for_everyone = true; msg.content = null; msg.attachments = []; }
      });
      if (state.currentChatId) renderMessages(state.currentChatId);
    });

    WS.on("typing", (data) => {
      if (data.chat_id !== state.currentChatId) return;
      el("typingIndicator").style.display = "flex";
      el("typingIndicator").innerHTML = `${UI.escapeHtml(data.username)} is typing <span class="typing-dots"><span></span><span></span><span></span></span>`;
      clearTimeout(state.typingTimers[data.chat_id]);
      state.typingTimers[data.chat_id] = setTimeout(() => { el("typingIndicator").style.display = "none"; }, 3000);
    });
    WS.on("stop_typing", (data) => {
      if (data.chat_id !== state.currentChatId) return;
      el("typingIndicator").style.display = "none";
    });

    WS.on("presence", (data) => {
      state.chats.forEach((chat) => {
        chat.members.forEach((m) => {
          if (m.id === data.user_id) { m.is_online = data.is_online; if (data.last_seen) m.last_seen = data.last_seen; }
        });
      });
      renderChatList();
      const chat = state.chats.find((c) => c.id === state.currentChatId);
      if (chat) renderChatHeader(chat);
    });

    WS.on("disconnected", () => UI.toast("Connection lost — reconnecting…", "error"));
    WS.on("connected", () => { /* silent */ });
  }

  function notifyIfEnabled(m) {
    if (localStorage.getItem("nimbus_notify") !== "1") return;
    if (document.hasFocus() && m.chat_id === state.currentChatId) return;
    if (Notification.permission === "granted") {
      new Notification(m.sender_username, { body: m.content || "Sent an attachment", icon: m.sender_avatar || "" });
    }
  }

  // ---------------- MOBILE BACK ----------------
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal-overlay.show").forEach((m) => m.classList.remove("show"));
  });

  function debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
  }

  function bindUI() {
    el("mobileBackBtn").addEventListener("click", () => {
      document.getElementById("sidebar").classList.remove("chat-open");
    });
    el("voiceCallBtn").addEventListener("click", () => { if (window.Calls) Calls.startCall("audio"); });
    el("videoCallBtn").addEventListener("click", () => { if (window.Calls) Calls.startCall("video"); });
  }

  init();
})();
