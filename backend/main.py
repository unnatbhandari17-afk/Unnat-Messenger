"""
Messenger backend entrypoint.

Run with:
    uvicorn main:app --reload --port 8000

Serves:
    - REST API under /api/*
    - WebSocket endpoint at /ws?token=<jwt>
    - Uploaded files at /uploads/*
    - The frontend static site at /
"""
import datetime
import json
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

import models
from database import engine, get_db, SessionLocal
from websocket_manager import manager
from call_manager import call_manager
from auth import get_current_user_ws

from routers import auth as auth_router
from routers import users as users_router
from routers import chats as chats_router
from routers import messages as messages_router
from routers import uploads as uploads_router
from routers import notifications as notifications_router

# Create all database tables on startup (SQLite dev database)
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Messenger API", version="1.0.0")

# CORS: allow the frontend (served from the same app, but kept permissive
# for local development where the frontend might be opened on another port)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(users_router.router)
app.include_router(chats_router.router)
app.include_router(messages_router.router)
app.include_router(uploads_router.router)
app.include_router(notifications_router.router)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}


def _chat_member_ids(db: Session, chat_id: int):
    return [m.user_id for m in db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id).all()]


def _share_direct_chat(db: Session, user_a: int, user_b: int) -> bool:
    """True if the two users are both members of at least one direct chat
    together (used to stop arbitrary user IDs from being call-invited)."""
    chat_ids_a = {
        m.chat_id for m in db.query(models.ChatMember).filter(models.ChatMember.user_id == user_a).all()
    }
    if not chat_ids_a:
        return False
    match = (
        db.query(models.Chat)
        .join(models.ChatMember, models.ChatMember.chat_id == models.Chat.id)
        .filter(
            models.Chat.id.in_(chat_ids_a),
            models.Chat.type == models.ChatType.direct,
            models.ChatMember.user_id == user_b,
        )
        .first()
    )
    return match is not None


def _is_blocked(db: Session, user_a: int, user_b: int) -> bool:
    return (
        db.query(models.BlockedUser)
        .filter(
            models.BlockedUser.blocker_id.in_([user_a, user_b]),
            models.BlockedUser.blocked_id.in_([user_a, user_b]),
        )
        .first()
        is not None
    )


def _contact_ids(db: Session, user_id: int):
    """All users who share at least one chat with this user (used for presence broadcasts)."""
    memberships = db.query(models.ChatMember).filter(models.ChatMember.user_id == user_id).all()
    chat_ids = [m.chat_id for m in memberships]
    if not chat_ids:
        return []
    others = (
        db.query(models.ChatMember.user_id)
        .filter(models.ChatMember.chat_id.in_(chat_ids), models.ChatMember.user_id != user_id)
        .distinct()
        .all()
    )
    return [o[0] for o in others]


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str):
    db = SessionLocal()
    user = get_current_user_ws(token, db)
    if user is None:
        await websocket.close(code=4001)
        db.close()
        return

    await manager.connect(user.id, websocket)
    user.is_online = True
    db.commit()

    contacts = _contact_ids(db, user.id)
    await manager.broadcast_to_users(
        contacts,
        {"event": "presence", "user_id": user.id, "is_online": True, "last_seen": None},
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            event = data.get("event")

            if event == "typing":
                chat_id = data.get("chat_id")
                if chat_id:
                    member_ids = [uid for uid in _chat_member_ids(db, chat_id) if uid != user.id]
                    await manager.broadcast_to_users(
                        member_ids,
                        {"event": "typing", "chat_id": chat_id, "user_id": user.id, "username": user.username},
                    )

            elif event == "stop_typing":
                chat_id = data.get("chat_id")
                if chat_id:
                    member_ids = [uid for uid in _chat_member_ids(db, chat_id) if uid != user.id]
                    await manager.broadcast_to_users(
                        member_ids,
                        {"event": "stop_typing", "chat_id": chat_id, "user_id": user.id},
                    )

            elif event == "ping":
                await websocket.send_text(json.dumps({"event": "pong"}))

            # ---------------- WebRTC call signalling ----------------
            # All of these simply validate + relay to the other participant;
            # the actual audio/video never passes through the server.

            elif event == "call_invite":
                call_id = data.get("call_id")
                to_user_id = data.get("to_user_id")
                chat_id = data.get("chat_id")
                call_type = data.get("call_type") if data.get("call_type") in ("audio", "video") else "audio"
                sdp = data.get("sdp")
                if not call_id or not to_user_id or not sdp:
                    continue
                to_user_id = int(to_user_id)

                if call_manager.is_busy(user.id):
                    continue  # caller's own client should prevent this; ignore defensively
                if not _share_direct_chat(db, user.id, to_user_id) or _is_blocked(db, user.id, to_user_id):
                    await websocket.send_text(json.dumps({"event": "call_unavailable", "call_id": call_id}))
                    continue
                if not manager.is_online(to_user_id):
                    await websocket.send_text(json.dumps({"event": "call_unavailable", "call_id": call_id}))
                    continue
                if call_manager.is_busy(to_user_id):
                    await websocket.send_text(json.dumps({"event": "call_busy", "call_id": call_id}))
                    continue

                call_manager.create_call(call_id, user.id, to_user_id, chat_id, call_type)
                await manager.send_to_user(to_user_id, {
                    "event": "call_invite",
                    "call_id": call_id,
                    "chat_id": chat_id,
                    "call_type": call_type,
                    "from_user_id": user.id,
                    "from_username": user.username,
                    "from_avatar": user.avatar_url,
                    "sdp": sdp,
                })

            elif event == "call_accept":
                call_id = data.get("call_id")
                sdp = data.get("sdp")
                state = call_manager.get(call_id)
                if not state or state.callee_id != user.id or not sdp:
                    continue
                call_manager.accept(call_id)
                await manager.send_to_user(state.caller_id, {
                    "event": "call_accept", "call_id": call_id, "from_user_id": user.id, "sdp": sdp,
                })
                # Close the ringing popup on this user's other open tabs/devices
                await manager.send_to_user_except(user.id, websocket, {
                    "event": "call_closed_elsewhere", "call_id": call_id,
                })

            elif event == "call_reject":
                call_id = data.get("call_id")
                state = call_manager.end_call(call_id)
                if not state:
                    continue
                peer_id = state.peer_of(user.id)
                if peer_id:
                    await manager.send_to_user(peer_id, {"event": "call_reject", "call_id": call_id, "from_user_id": user.id})
                await manager.send_to_user_except(user.id, websocket, {"event": "call_closed_elsewhere", "call_id": call_id})

            elif event == "call_cancel":
                call_id = data.get("call_id")
                state = call_manager.end_call(call_id)
                if not state:
                    continue
                peer_id = state.peer_of(user.id)
                if peer_id:
                    await manager.send_to_user(peer_id, {"event": "call_cancel", "call_id": call_id, "from_user_id": user.id})
                await manager.send_to_user_except(user.id, websocket, {"event": "call_closed_elsewhere", "call_id": call_id})

            elif event == "call_end":
                call_id = data.get("call_id")
                state = call_manager.end_call(call_id)
                if not state:
                    continue
                peer_id = state.peer_of(user.id)
                if peer_id:
                    await manager.send_to_user(peer_id, {"event": "call_end", "call_id": call_id, "from_user_id": user.id})
                await manager.send_to_user_except(user.id, websocket, {"event": "call_end", "call_id": call_id, "from_user_id": user.id})

            elif event == "call_signal":
                # Relay SDP renegotiation (ICE restart) / ICE candidates / mute-state to the other participant
                call_id = data.get("call_id")
                state = call_manager.get(call_id)
                if not state:
                    continue
                peer_id = state.peer_of(user.id)
                if not peer_id:
                    continue
                await manager.send_to_user(peer_id, {
                    "event": "call_signal",
                    "call_id": call_id,
                    "from_user_id": user.id,
                    "signal_type": data.get("signal_type"),
                    "payload": data.get("payload"),
                })

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(user.id, websocket)
        # Only mark offline if this was the user's last active connection
        if not manager.is_online(user.id):
            user.is_online = False
            user.last_seen = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            db.commit()
            contacts = _contact_ids(db, user.id)
            await manager.broadcast_to_users(
                contacts,
                {
                    "event": "presence",
                    "user_id": user.id,
                    "is_online": False,
                    "last_seen": user.last_seen.isoformat(),
                },
            )
            # Gracefully end any in-progress call rather than leaving the
            # other participant's client hanging with a dead connection.
            peer_id, call_id = call_manager.end_calls_for_user(user.id)
            if peer_id:
                await manager.send_to_user(peer_id, {"event": "call_end", "call_id": call_id, "reason": "peer_disconnected"})
        db.close()


# Serve the frontend as a static site (index.html, chat.html, css/, js/)
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
