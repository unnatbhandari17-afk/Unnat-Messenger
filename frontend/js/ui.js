/**
 * Shared, framework-free UI helpers used across the app: toasts, modal
 * open/close, date/time formatting, and the emoji picker data set.
 */
const UI = {
  toast(message, type = "success") {
    const container = document.getElementById("toastContainer");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.3s";
      setTimeout(() => el.remove(), 300);
    }, 3200);
  },

  openModal(id) {
    document.getElementById(id).classList.add("show");
  },
  closeModal(id) {
    document.getElementById(id).classList.remove("show");
  },

  formatTime(dateStr) {
    const d = new Date(dateStr + (dateStr.endsWith("Z") ? "" : "Z"));
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  },

  formatDay(dateStr) {
    const d = new Date(dateStr + (dateStr.endsWith("Z") ? "" : "Z"));
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
  },

  formatRelative(dateStr) {
    const d = new Date(dateStr + (dateStr.endsWith("Z") ? "" : "Z"));
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  },

  lastSeenLabel(dateStr) {
    return `last seen ${UI.formatRelative(dateStr)} ago`;
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },

  defaultAvatar(seed) {
    // Deterministic gradient-avatar placeholder using initials
    return null; // handled via initials in renderAvatar
  },

  EMOJIS: [
    "😀","😁","😂","🤣","😊","😍","😘","😜","🤔","😎",
    "😢","😭","😡","😱","🥳","👍","👎","👏","🙏","💪",
    "❤️","🔥","🎉","✨","💯","👋","🤝","🙌","😴","🤩",
    "😇","🤗","😅","😆","🙄","😬","🤯","🥰","😋","🤤",
    "🎂","🎈","☕","🍕","🍔","⚽","🏀","🎮","📷","🎵",
  ],

  QUICK_REACTIONS: ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉"],
};

// Close any modal when clicking its overlay background or a [data-close] button
document.addEventListener("click", (e) => {
  if (e.target.classList && e.target.classList.contains("modal-overlay")) {
    e.target.classList.remove("show");
  }
  if (e.target.dataset && e.target.dataset.close) {
    UI.closeModal(e.target.dataset.close);
  }
});
