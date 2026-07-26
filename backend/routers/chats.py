"""
Chat endpoints: create direct/group chats, list chats with previews,
pin/archive, group membership management.
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import desc

import models
import schemas
from database import get_db
from auth import get_current_user

router = APIRouter(prefix="/api/chats", tags=["chats"])


def _member_ids(db: Session, chat_id: int) -> List[int]:
    return [m.user_id for m in db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id).all()]


def _chat_to_out(db: Session, chat: models.Chat, current_user: models.User) -> schemas.ChatOut:
    members = [m.user for m in chat.members]
    my_membership = next((m for m in chat.members if m.user_id == current_user.id), None)

    last_msg = (
        db.query(models.Message)
        .filter(models.Message.chat_id == chat.id)
        .order_by(desc(models.Message.created_at))
        .first()
    )
    unread_count = 0
    if my_membership:
        q = db.query(models.Message).filter(models.Message.chat_id == chat.id, models.Message.sender_id != current_user.id)
        if my_membership.last_read_message_id:
            q = q.filter(models.Message.id > my_membership.last_read_message_id)
        unread_count = q.count()

    display_name = chat.name
    display_icon = chat.icon_url
    if chat.type == models.ChatType.direct:
        other = next((m for m in members if m.id != current_user.id), None)
        if other:
            display_name = other.username
            display_icon = other.avatar_url

    return schemas.ChatOut(
        id=chat.id,
        type=chat.type.value if hasattr(chat.type, "value") else chat.type,
        name=display_name,
        description=chat.description,
        icon_url=display_icon,
        created_at=chat.created_at,
        members=members,
        last_message=(last_msg.content if last_msg else None),
        last_message_at=(last_msg.created_at if last_msg else None),
        unread_count=unread_count,
        is_pinned=(my_membership.is_pinned if my_membership else False),
        is_archived=(my_membership.is_archived if my_membership else False),
    )


@router.get("", response_model=List[schemas.ChatOut])
def list_chats(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    memberships = db.query(models.ChatMember).filter(models.ChatMember.user_id == current_user.id).all()
    chats = [m.chat for m in memberships]
    out = [_chat_to_out(db, c, current_user) for c in chats]
    # Pinned first, then by most recent activity
    out.sort(key=lambda c: (not c.is_pinned, -(c.last_message_at.timestamp() if c.last_message_at else 0)))
    return out


@router.post("", response_model=schemas.ChatOut)
def create_chat(data: schemas.ChatCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    if data.type == "direct":
        if len(data.member_ids) != 1:
            raise HTTPException(status_code=400, detail="Direct chat requires exactly one other member")
        other_id = data.member_ids[0]

        # Reuse existing direct chat if one already exists between these two users
        existing_chats = (
            db.query(models.Chat)
            .join(models.ChatMember)
            .filter(models.Chat.type == models.ChatType.direct, models.ChatMember.user_id == current_user.id)
            .all()
        )
        for c in existing_chats:
            member_ids = _member_ids(db, c.id)
            if set(member_ids) == {current_user.id, other_id}:
                return _chat_to_out(db, c, current_user)

        other_user = db.query(models.User).filter(models.User.id == other_id).first()
        if not other_user:
            raise HTTPException(status_code=404, detail="User not found")

        chat = models.Chat(type=models.ChatType.direct, created_by=current_user.id)
        db.add(chat)
        db.commit()
        db.refresh(chat)
        db.add(models.ChatMember(chat_id=chat.id, user_id=current_user.id))
        db.add(models.ChatMember(chat_id=chat.id, user_id=other_id))
        db.commit()
        db.refresh(chat)
        return _chat_to_out(db, chat, current_user)

    else:  # group
        if not data.name:
            raise HTTPException(status_code=400, detail="Group name is required")
        chat = models.Chat(
            type=models.ChatType.group,
            name=data.name,
            description=data.description or "",
            created_by=current_user.id,
        )
        db.add(chat)
        db.commit()
        db.refresh(chat)

        db.add(models.ChatMember(chat_id=chat.id, user_id=current_user.id, is_admin=True))
        for uid in set(data.member_ids):
            if uid != current_user.id:
                db.add(models.ChatMember(chat_id=chat.id, user_id=uid))
        db.commit()
        db.refresh(chat)
        return _chat_to_out(db, chat, current_user)


@router.get("/{chat_id}", response_model=schemas.ChatOut)
def get_chat(chat_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.Chat).filter(models.Chat.id == chat_id).first()
    if not chat or current_user.id not in _member_ids(db, chat_id):
        raise HTTPException(status_code=404, detail="Chat not found")
    return _chat_to_out(db, chat, current_user)


@router.put("/{chat_id}/pin")
def toggle_pin(chat_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    membership = (
        db.query(models.ChatMember)
        .filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == current_user.id)
        .first()
    )
    if not membership:
        raise HTTPException(status_code=404, detail="Chat not found")
    membership.is_pinned = not membership.is_pinned
    db.commit()
    return {"is_pinned": membership.is_pinned}


@router.put("/{chat_id}/archive")
def toggle_archive(chat_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    membership = (
        db.query(models.ChatMember)
        .filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == current_user.id)
        .first()
    )
    if not membership:
        raise HTTPException(status_code=404, detail="Chat not found")
    membership.is_archived = not membership.is_archived
    db.commit()
    return {"is_archived": membership.is_archived}


@router.put("/{chat_id}/read")
def mark_read(chat_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    membership = (
        db.query(models.ChatMember)
        .filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == current_user.id)
        .first()
    )
    if not membership:
        raise HTTPException(status_code=404, detail="Chat not found")
    last_msg = (
        db.query(models.Message)
        .filter(models.Message.chat_id == chat_id)
        .order_by(desc(models.Message.created_at))
        .first()
    )
    if last_msg:
        membership.last_read_message_id = last_msg.id
        for m in db.query(models.Message).filter(models.Message.chat_id == chat_id, models.Message.sender_id != current_user.id):
            receipt = (
                db.query(models.MessageReceipt)
                .filter(models.MessageReceipt.message_id == m.id, models.MessageReceipt.user_id == current_user.id)
                .first()
            )
            if receipt:
                receipt.status = models.ReceiptStatus.seen
            else:
                db.add(models.MessageReceipt(message_id=m.id, user_id=current_user.id, status=models.ReceiptStatus.seen))
        db.commit()
    return {"detail": "marked as read"}


# ---------- Group management ----------

@router.put("/{chat_id}/group", response_model=schemas.ChatOut)
def update_group(chat_id: int, data: schemas.GroupUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.Chat).filter(models.Chat.id == chat_id, models.Chat.type == models.ChatType.group).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Group not found")
    membership = db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == current_user.id).first()
    if not membership or not membership.is_admin:
        raise HTTPException(status_code=403, detail="Only admins can update group info")
    if data.name is not None:
        chat.name = data.name
    if data.description is not None:
        chat.description = data.description
    db.commit()
    db.refresh(chat)
    return _chat_to_out(db, chat, current_user)


@router.post("/{chat_id}/members", response_model=schemas.ChatOut)
def add_member(chat_id: int, data: schemas.GroupMemberAction, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.Chat).filter(models.Chat.id == chat_id, models.Chat.type == models.ChatType.group).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Group not found")
    membership = db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == current_user.id).first()
    if not membership or not membership.is_admin:
        raise HTTPException(status_code=403, detail="Only admins can add members")
    existing = db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == data.user_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="User is already a member")
    db.add(models.ChatMember(chat_id=chat_id, user_id=data.user_id))
    db.commit()
    db.refresh(chat)
    return _chat_to_out(db, chat, current_user)


@router.delete("/{chat_id}/members/{user_id}", response_model=schemas.ChatOut)
def remove_member(chat_id: int, user_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.Chat).filter(models.Chat.id == chat_id, models.Chat.type == models.ChatType.group).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Group not found")
    membership = db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == current_user.id).first()
    is_self_leave = user_id == current_user.id
    if not is_self_leave and (not membership or not membership.is_admin):
        raise HTTPException(status_code=403, detail="Only admins can remove members")
    db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == user_id).delete()
    db.commit()
    db.refresh(chat)
    return _chat_to_out(db, chat, current_user)


@router.put("/{chat_id}/members/{user_id}/admin", response_model=schemas.ChatOut)
def toggle_admin(chat_id: int, user_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.Chat).filter(models.Chat.id == chat_id, models.Chat.type == models.ChatType.group).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Group not found")
    requester = db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == current_user.id).first()
    if not requester or not requester.is_admin:
        raise HTTPException(status_code=403, detail="Only admins can change admin status")
    target = db.query(models.ChatMember).filter(models.ChatMember.chat_id == chat_id, models.ChatMember.user_id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Member not found")
    target.is_admin = not target.is_admin
    db.commit()
    db.refresh(chat)
    return _chat_to_out(db, chat, current_user)
