"""
SQLAlchemy ORM models representing the full database schema:
Users, Chats, ChatMembers, Messages, Attachments, Reactions,
Groups (folded into Chats), Notifications, BlockedUsers, Settings.
"""
import datetime
import enum
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey, Text, Enum
)
from sqlalchemy.orm import relationship
from database import Base


def now():
    # datetime.utcnow() is deprecated as of Python 3.12+; build a naive UTC
    # timestamp explicitly instead so the stored values still line up with
    # the (timezone-naive) SQLite DateTime columns below.
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(32), unique=True, index=True, nullable=False)
    email = Column(String(120), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    avatar_url = Column(String(255), default="")
    cover_url = Column(String(255), default="")
    about = Column(String(255), default="Hey there! I am using Messenger.")
    status_text = Column(String(64), default="")
    is_online = Column(Boolean, default=False)
    last_seen = Column(DateTime, default=now)
    theme = Column(String(10), default="light")
    created_at = Column(DateTime, default=now)

    memberships = relationship("ChatMember", back_populates="user", cascade="all, delete-orphan")
    messages = relationship("Message", back_populates="sender", cascade="all, delete-orphan")


class ChatType(str, enum.Enum):
    direct = "direct"
    group = "group"


class Chat(Base):
    __tablename__ = "chats"

    id = Column(Integer, primary_key=True, index=True)
    type = Column(Enum(ChatType), default=ChatType.direct)
    name = Column(String(64), nullable=True)          # group name (null for direct chats)
    description = Column(String(255), nullable=True)  # group description
    icon_url = Column(String(255), nullable=True)      # group icon
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=now)

    members = relationship("ChatMember", back_populates="chat", cascade="all, delete-orphan")
    messages = relationship("Message", back_populates="chat", cascade="all, delete-orphan")


class ChatMember(Base):
    __tablename__ = "chat_members"

    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(Integer, ForeignKey("chats.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    is_admin = Column(Boolean, default=False)
    is_pinned = Column(Boolean, default=False)
    is_archived = Column(Boolean, default=False)
    joined_at = Column(DateTime, default=now)
    last_read_message_id = Column(Integer, nullable=True)

    chat = relationship("Chat", back_populates="members")
    user = relationship("User", back_populates="memberships")


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(Integer, ForeignKey("chats.id"), nullable=False)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    content = Column(Text, nullable=True)
    reply_to_id = Column(Integer, ForeignKey("messages.id"), nullable=True)
    forwarded_from_id = Column(Integer, nullable=True)
    is_edited = Column(Boolean, default=False)
    is_deleted_for_everyone = Column(Boolean, default=False)
    created_at = Column(DateTime, default=now)
    edited_at = Column(DateTime, nullable=True)

    chat = relationship("Chat", back_populates="messages")
    sender = relationship("User", back_populates="messages")
    attachments = relationship("Attachment", back_populates="message", cascade="all, delete-orphan")
    reactions = relationship("Reaction", back_populates="message", cascade="all, delete-orphan")
    receipts = relationship("MessageReceipt", back_populates="message", cascade="all, delete-orphan")
    deletions = relationship("MessageDeletion", back_populates="message", cascade="all, delete-orphan")


class Attachment(Base):
    __tablename__ = "attachments"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False)
    file_name = Column(String(255), nullable=False)
    file_path = Column(String(255), nullable=False)
    file_type = Column(String(50), nullable=False)  # image, video, audio, document
    file_size = Column(Integer, default=0)

    message = relationship("Message", back_populates="attachments")


class Reaction(Base):
    __tablename__ = "reactions"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    emoji = Column(String(10), nullable=False)

    message = relationship("Message", back_populates="reactions")


class ReceiptStatus(str, enum.Enum):
    delivered = "delivered"
    seen = "seen"


class MessageReceipt(Base):
    """Tracks per-user delivered/seen status for a message (for group support)."""
    __tablename__ = "message_receipts"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(Enum(ReceiptStatus), default=ReceiptStatus.delivered)
    updated_at = Column(DateTime, default=now)

    message = relationship("Message", back_populates="receipts")


class MessageDeletion(Base):
    """'Delete for me' — hides a message for a specific user only."""
    __tablename__ = "message_deletions"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    message = relationship("Message", back_populates="deletions")


class BlockedUser(Base):
    __tablename__ = "blocked_users"

    id = Column(Integer, primary_key=True, index=True)
    blocker_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    blocked_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=now)


class Notification(Base):
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    type = Column(String(30), nullable=False)  # message, reaction, group_add, etc.
    content = Column(String(255), nullable=False)
    related_chat_id = Column(Integer, nullable=True)
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=now)
