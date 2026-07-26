"""
Message endpoints: send, fetch (paginated), edit, delete, react, search.
All mutating actions broadcast the corresponding event over WebSocket to
every other member of the chat, so connected clients update instantly.
"""
import asyncio
import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import desc, or_

import models
import schemas
from database import get_db
from auth import get_current_user
from websocket_manager import manager

router = APIRouter(prefix="/api/messages", tags=["messages"])

EDIT_WINDOW_MINUTES = 15


def _member_ids(db: Session, chat_id: int) -> List[int]:
    return [m.user_id for m in db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id).all()]


def _require_member(db: Session, chat_id: int, user_id: int):
    if user_id not in _member_ids(db, chat_id):
        raise HTTPException(status_code=403, detail="You are not a member of this chat")


def _message_to_out(db: Session, msg: models.Message, viewer_id: int) -> schemas.MessageOut:
    status_value = "sent"
    receipts = db.query(models.MessageReceipt).filter(models.MessageReceipt.message_id == msg.id).all()
    other_member_ids = [uid for uid in _member_ids(db, msg.chat_id) if uid != msg.sender_id]
    if other_member_ids:
        statuses = {r.user_id: r.status for r in receipts}
        if other_member_ids and all(statuses.get(uid) == models.ReceiptStatus.seen for uid in other_member_ids):
            status_value = "seen"
        elif any(uid in statuses for uid in other_member_ids):
            status_value = "delivered"

    content = msg.content
    if msg.is_deleted_for_everyone:
        content = None

    is_deleted_for_viewer = any(d.user_id == viewer_id for d in msg.deletions)

    return schemas.MessageOut(
        id=msg.id,
        chat_id=msg.chat_id,
        sender_id=msg.sender_id,
        sender_username=msg.sender.username,
        sender_avatar=msg.sender.avatar_url,
        content=("" if is_deleted_for_viewer else content),
        reply_to_id=msg.reply_to_id,
        forwarded_from_id=msg.forwarded_from_id,
        is_edited=msg.is_edited,
        is_deleted_for_everyone=msg.is_deleted_for_everyone,
        created_at=msg.created_at,
        edited_at=msg.edited_at,
        attachments=([] if is_deleted_for_viewer or msg.is_deleted_for_everyone else msg.attachments),
        reactions=msg.reactions,
        status=status_value,
    )


@router.get("/{chat_id}", response_model=List[schemas.MessageOut])
def get_messages(
    chat_id: int,
    before_id: Optional[int] = None,
    limit: int = 30,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Paginated message history (infinite scroll: pass before_id of the oldest loaded message)."""
    _require_member(db, chat_id, current_user.id)
    q = db.query(models.Message).filter(models.Message.chat_id == chat_id)
    if before_id:
        q = q.filter(models.Message.id < before_id)
    msgs = q.order_by(desc(models.Message.id)).limit(min(limit, 100)).all()
    msgs.reverse()

    # Mark messages as delivered for the viewer (they've now fetched them)
    for m in msgs:
        if m.sender_id != current_user.id:
            existing = (
                db.query(models.MessageReceipt)
                .filter(models.MessageReceipt.message_id == m.id, models.MessageReceipt.user_id == current_user.id)
                .first()
            )
            if not existing:
                db.add(models.MessageReceipt(message_id=m.id, user_id=current_user.id, status=models.ReceiptStatus.delivered))
    db.commit()

    return [_message_to_out(db, m, current_user.id) for m in msgs]


@router.post("", response_model=schemas.MessageOut)
async def send_message(
    data: schemas.MessageCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _require_member(db, data.chat_id, current_user.id)
    # Note: content may legitimately be empty here when the client is about
    # to attach a file via POST /api/uploads/attachment/{message_id} next.
    # The frontend guarantees the user provided either text or a file before
    # calling this endpoint at all.

    msg = models.Message(
        chat_id=data.chat_id,
        sender_id=current_user.id,
        content=data.content,
        reply_to_id=data.reply_to_id,
        forwarded_from_id=data.forwarded_from_id,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    out = _message_to_out(db, msg, current_user.id)
    # Broadcast to every member INCLUDING the sender's own other tabs/devices,
    # so a second open tab/device stays in sync too. The frontend de-dupes by
    # message id, so this never produces a duplicate bubble on the sending tab.
    await manager.broadcast_to_users(_member_ids(db, data.chat_id), {"event": "new_message", "message": out.model_dump(mode="json")})

    return out


@router.put("/{message_id}", response_model=schemas.MessageOut)
async def edit_message(
    message_id: int,
    data: schemas.MessageEdit,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    msg = db.query(models.Message).filter(models.Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own messages")
    age = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - msg.created_at
    if age.total_seconds() > EDIT_WINDOW_MINUTES * 60:
        raise HTTPException(status_code=400, detail=f"Messages can only be edited within {EDIT_WINDOW_MINUTES} minutes")

    msg.content = data.content
    msg.is_edited = True
    msg.edited_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(msg)

    out = _message_to_out(db, msg, current_user.id)
    await manager.broadcast_to_users(_member_ids(db, msg.chat_id), {"event": "message_edited", "message": out.model_dump(mode="json")})
    return out


@router.delete("/{message_id}")
async def delete_message(
    message_id: int,
    for_everyone: bool = False,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    msg = db.query(models.Message).filter(models.Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    _require_member(db, msg.chat_id, current_user.id)

    if for_everyone:
        if msg.sender_id != current_user.id:
            raise HTTPException(status_code=403, detail="You can only delete your own messages for everyone")
        msg.is_deleted_for_everyone = True
        msg.content = None
        db.commit()
        await manager.broadcast_to_users(_member_ids(db, msg.chat_id), {"event": "message_deleted", "message_id": message_id, "for_everyone": True})
    else:
        existing = (
            db.query(models.MessageDeletion)
            .filter(models.MessageDeletion.message_id == message_id, models.MessageDeletion.user_id == current_user.id)
            .first()
        )
        if not existing:
            db.add(models.MessageDeletion(message_id=message_id, user_id=current_user.id))
            db.commit()

    return {"detail": "Message deleted"}


@router.post("/{message_id}/reactions", response_model=schemas.MessageOut)
async def react_to_message(
    message_id: int,
    data: schemas.ReactionCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    msg = db.query(models.Message).filter(models.Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    _require_member(db, msg.chat_id, current_user.id)

    existing = (
        db.query(models.Reaction)
        .filter(models.Reaction.message_id == message_id, models.Reaction.user_id == current_user.id)
        .first()
    )
    if existing and existing.emoji == data.emoji:
        db.delete(existing)  # toggle off if reacting with the same emoji again
    elif existing:
        existing.emoji = data.emoji
    else:
        db.add(models.Reaction(message_id=message_id, user_id=current_user.id, emoji=data.emoji))
    db.commit()
    db.refresh(msg)

    out = _message_to_out(db, msg, current_user.id)
    await manager.broadcast_to_users(_member_ids(db, msg.chat_id), {"event": "message_reaction", "message": out.model_dump(mode="json")})
    return out


@router.get("/search/{chat_id}", response_model=List[schemas.MessageOut])
def search_messages(chat_id: int, q: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _require_member(db, chat_id, current_user.id)
    msgs = (
        db.query(models.Message)
        .filter(models.Message.chat_id == chat_id, models.Message.content.ilike(f"%{q}%"))
        .order_by(desc(models.Message.created_at))
        .limit(50)
        .all()
    )
    return [_message_to_out(db, m, current_user.id) for m in msgs]
