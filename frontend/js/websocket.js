/**
 * Manages the single WebSocket connection to the backend, with automatic
 * reconnection after network loss (with backoff) and a simple pub/sub
 * interface so chat.js can react to server-pushed events.
 */
const WS = {
  socket: null,
  handlers: {},
  reconnectAttempts: 0,
  intentionalClose: false,

  connect() {
    const token = Api.getToken();
    if (!token) return;
    this.intentionalClose = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this._emit("connected", {});
      // Keep the connection alive through proxies/timeouts
      this._pingInterval = setInterval(() => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ event: "ping" }));
        }
      }, 25000);
    };

    this.socket.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      if (data.event) this._emit(data.event, data);
    };

    this.socket.onclose = () => {
      clearInterval(this._pingInterval);
      this._emit("disconnected", {});
      if (!this.intentionalClose) {
        const delay = Math.min(1000 * Math.pow(1.6, this.reconnectAttempts), 15000);
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), delay);
      }
    };

    this.socket.onerror = () => {
      // onclose will fire next and handle reconnection
    };
  },

  disconnect() {
    this.intentionalClose = true;
    clearInterval(this._pingInterval);
    if (this.socket) this.socket.close();
  },

  send(payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  },

  on(event, callback) {
    (this.handlers[event] = this.handlers[event] || []).push(callback);
  },

  _emit(event, data) {
    (this.handlers[event] || []).forEach((cb) => cb(data));
  },
};
