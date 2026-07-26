"""
File upload endpoints. Handles message attachments (images, video, audio,
documents, zip, etc.) and profile picture / cover image uploads.

Security: file extension allow-listing, size limits, and randomised
storage filenames to prevent path traversal / overwrite attacks.
"""
import os
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

import models
import schemas
from database import get_db
from auth import get_current_user
from websocket_manager import manager
from routers.messages import _member_ids, _message_to_out

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB

ALLOWED_EXTENSIONS = {
    ".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image", ".webp": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video",
    ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
    ".pdf": "document", ".doc": "document", ".docx": "document",
    ".xls": "document", ".xlsx": "document", ".ppt": "document", ".pptx": "document",
    ".txt": "document", ".zip": "document", ".rar": "document",
}


def _validate_and_save(file: UploadFile, contents: bytes) -> tuple[str, str, str]:
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type '{ext}' is not allowed")
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File exceeds the 25 MB size limit")

    stored_name = f"{uuid.uuid4().hex}{ext}"
    dest_path = os.path.join(UPLOAD_DIR, stored_name)
    with open(dest_path, "wb") as f:
        f.write(contents)

    file_type = ALLOWED_EXTENSIONS[ext]
    return stored_name, file_type, f"/uploads/{stored_name}"


@router.post("/attachment/{message_id}", response_model=schemas.AttachmentOut)
async def upload_attachment(
    message_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    msg = db.query(models.Message).filter(models.Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only attach files to your own messages")

    contents = await file.read()
    stored_name, file_type, url_path = _validate_and_save(file, contents)

    attachment = models.Attachment(
        message_id=message_id,
        file_name=file.filename,
        file_path=url_path,
        file_type=file_type,
        file_size=len(contents),
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)

    # Broadcast the now-complete message (with its attachment) to every chat
    # member, including the sender's own other tabs/devices. Without this,
    # a message is created (and broadcast) *before* its file finishes
    # uploading, so recipients only ever saw the attachment after a manual
    # refresh. This closes that gap for images, video, audio/voice notes,
    # and documents alike, since they all flow through this one endpoint.
    db.refresh(msg)
    out = _message_to_out(db, msg, current_user.id)
    await manager.broadcast_to_users(
        _member_ids(db, msg.chat_id),
        {"event": "message_attachment", "message": out.model_dump(mode="json")},
    )

    return attachment


@router.post("/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    contents = await file.read()
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        raise HTTPException(status_code=400, detail="Avatar must be an image file")
    stored_name, _, url_path = _validate_and_save(file, contents)
    current_user.avatar_url = url_path
    db.commit()
    return {"avatar_url": url_path}


@router.post("/cover")
async def upload_cover(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    contents = await file.read()
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        raise HTTPException(status_code=400, detail="Cover must be an image file")
    stored_name, _, url_path = _validate_and_save(file, contents)
    current_user.cover_url = url_path
    db.commit()
    return {"cover_url": url_path}


@router.post("/group-icon/{chat_id}")
async def upload_group_icon(
    chat_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    chat = db.query(models.Chat).filter(models.Chat.id == chat_id, models.Chat.type == models.ChatType.group).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Group not found")
    contents = await file.read()
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        raise HTTPException(status_code=400, detail="Group icon must be an image file")
    stored_name, _, url_path = _validate_and_save(file, contents)
    chat.icon_url = url_path
    db.commit()
    return {"icon_url": url_path}
