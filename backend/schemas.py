"""
Pydantic schemas used for request validation and response serialization.
"""
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, EmailStr, field_validator


# ---------- Auth ----------

class UserRegister(BaseModel):
    username: str
    email: EmailStr
    password: str

    @field_validator("username")
    @classmethod
    def username_valid(cls, v):
        if len(v) < 3 or len(v) > 32:
            raise ValueError("Username must be 3-32 characters")
        if not v.replace("_", "").replace(".", "").isalnum():
            raise ValueError("Username may only contain letters, numbers, '_' and '.'")
        return v

    @field_validator("password")
    @classmethod
    def password_strength(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        if not any(c.isalpha() for c in v):
            raise ValueError("Password must contain at least one letter")
        return v


class UserLogin(BaseModel):
    username_or_email: str
    password: str
    remember_me: bool = False


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


# ---------- User ----------

class UserOut(BaseModel):
    id: int
    username: str
    email: str
    avatar_url: str
    cover_url: str
    about: str
    status_text: str
    is_online: bool
    last_seen: datetime
    theme: str

    class Config:
        from_attributes = True


class UserPublic(BaseModel):
    id: int
    username: str
    avatar_url: str
    about: str
    is_online: bool
    last_seen: datetime

    class Config:
        from_attributes = True


class UserUpdate(BaseModel):
    about: Optional[str] = None
    status_text: Optional[str] = None
    theme: Optional[str] = None


class PasswordChange(BaseModel):
    old_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


# ---------- Chats ----------

class ChatCreate(BaseModel):
    member_ids: List[int]
    type: str = "direct"
    name: Optional[str] = None
    description: Optional[str] = None


class ChatOut(BaseModel):
    id: int
    type: str
    name: Optional[str]
    description: Optional[str]
    icon_url: Optional[str]
    created_at: datetime
    members: List[UserPublic] = []
    last_message: Optional[str] = None
    last_message_at: Optional[datetime] = None
    unread_count: int = 0
    is_pinned: bool = False
    is_archived: bool = False

    class Config:
        from_attributes = True


class GroupMemberAction(BaseModel):
    user_id: int


class GroupUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


# ---------- Messages ----------

class MessageCreate(BaseModel):
    chat_id: int
    content: Optional[str] = None
    reply_to_id: Optional[int] = None
    forwarded_from_id: Optional[int] = None


class MessageEdit(BaseModel):
    content: str


class AttachmentOut(BaseModel):
    id: int
    file_name: str
    file_path: str
    file_type: str
    file_size: int

    class Config:
        from_attributes = True


class ReactionOut(BaseModel):
    id: int
    user_id: int
    emoji: str

    class Config:
        from_attributes = True


class MessageOut(BaseModel):
    id: int
    chat_id: int
    sender_id: int
    sender_username: str
    sender_avatar: str
    content: Optional[str]
    reply_to_id: Optional[int]
    forwarded_from_id: Optional[int]
    is_edited: bool
    is_deleted_for_everyone: bool
    created_at: datetime
    edited_at: Optional[datetime]
    attachments: List[AttachmentOut] = []
    reactions: List[ReactionOut] = []
    status: str = "sent"  # sent, delivered, seen

    class Config:
        from_attributes = True


class ReactionCreate(BaseModel):
    emoji: str


# ---------- Misc ----------

class BlockAction(BaseModel):
    user_id: int


class NotificationOut(BaseModel):
    id: int
    type: str
    content: str
    related_chat_id: Optional[int]
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True
