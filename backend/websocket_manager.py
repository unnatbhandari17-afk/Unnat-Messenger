"""
Manages active WebSocket connections and broadcasts real-time events
(new messages, typing indicators, presence, reactions, receipts) to the
relevant connected clients.
"""
import json
from typing import Dict, Set
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # user_id -> set of active websocket connections (supports multiple tabs/devices)
        self.active_connections: Dict[int, Set[WebSocket]] = {}

    async def connect(self, user_id: int, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.setdefault(user_id, set()).add(websocket)

    def disconnect(self, user_id: int, websocket: WebSocket):
        conns = self.active_connections.get(user_id)
        if conns and websocket in conns:
            conns.remove(websocket)
        if conns is not None and len(conns) == 0:
            self.active_connections.pop(user_id, None)

    def is_online(self, user_id: int) -> bool:
        return user_id in self.active_connections and len(self.active_connections[user_id]) > 0

    async def send_to_user(self, user_id: int, message: dict):
        conns = self.active_connections.get(user_id)
        if not conns:
            return
        payload = json.dumps(message)
        dead = []
        for ws in conns:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            conns.discard(ws)

    async def broadcast_to_users(self, user_ids, message: dict):
        for uid in user_ids:
            await self.send_to_user(uid, message)

    async def send_to_user_except(self, user_id: int, exclude_ws: WebSocket, message: dict):
        """Send to every active connection for this user except one (used so a
        user's other open tabs/devices can react to an action taken on the
        excluded connection, e.g. dismissing a ringing-call popup elsewhere
        once the call has been answered/declined on this one)."""
        conns = self.active_connections.get(user_id)
        if not conns:
            return
        payload = json.dumps(message)
        dead = []
        for ws in conns:
            if ws is exclude_ws:
                continue
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            conns.discard(ws)


manager = ConnectionManager()
