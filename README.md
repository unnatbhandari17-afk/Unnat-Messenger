# Nimbus Messenger

A real-time, Messenger-inspired chat application built with **FastAPI + WebSockets** on
the backend and **vanilla HTML/CSS/JS** on the frontend, styled with a glassmorphism
design system and full light/dark mode.

---

## ✅ What's actually implemented (fully working, no stubs)

- **Auth**: register / login / logout, JWT, bcrypt hashing, "remember me", password
  strength meter, forgot-password UI (frontend only, per spec).
- **Real-time messaging**: WebSocket-powered 1:1 and group chat, no page refresh.
- **Real-time media**: images, videos, voice messages, and files/documents all appear
  instantly for every recipient over WebSocket the moment the upload finishes — no
  manual refresh needed, on any tab or device.
- **Audio & video calling (WebRTC)**: one-to-one voice and video calls, signaled over
  the existing WebSocket connection (no separate signaling server). Call button,
  incoming-call popup with accept/reject, cancel (outgoing), end call, mute/unmute,
  camera on/off, switch camera (front/back, mobile-ready), fullscreen, call timer,
  generated ringtone/ringback, live connection-quality indicator, and graceful
  handling of drops/reconnects (ICE restart attempt, then a clean hang-up if the
  media path can't recover; the remote peer is notified immediately if the other
  side's browser disconnects). Works correctly across multiple open tabs/devices for
  the same account — accepting or declining on one tab dismisses the ringing popup
  on the others. No TURN server is configured (STUN only), so calls across strict
  symmetric NATs/corporate firewalls may need a TURN server added to `ICE_SERVERS`
  in `frontend/js/calls.js`.
- **Presence**: online/offline dot, "last seen", live typing indicator ("`username`
  is typing…") that sends at most one WebSocket event per typing burst (not per
  keystroke) and clears itself automatically after a few seconds of inactivity.
- **Rich messages**: text, emoji picker, image/video/audio/document attachments,
  drag-and-drop upload, clipboard-paste image upload, voice messages recorded live
  in the browser (MediaRecorder) and sent as playable audio attachments.
- **Message actions**: reply (with preview), forward to another chat, edit within a
  15-minute window (shows "edited"), delete for me / delete for everyone with
  confirmation, emoji reactions (👍❤️😂😮😢🔥🎉) that update instantly for every
  participant (including your own other tabs/devices), support switching to a
  different emoji, support removing a reaction, and persist across refreshes; read
  receipts (sent/delivered/seen).
- **Search**: people search, in-chat message search with live results.
- **Groups**: create, add/remove members, multiple admins, leave group, group name/description.
- **Sidebar**: pinned & archived chats, unread badges, last-message preview, filters
  (All / Unread / Pinned / Archived / Groups).
- **Profile & settings**: avatar + cover photo upload, about/status text, change
  password, dark/light theme (persisted per-user and in `localStorage`), blocked
  users list with block/unblock (also enforced for calls), browser desktop notifications.
- **Security**: bcrypt password hashing, JWT-protected routes, file-type allow-listing
  and size limits on uploads, parameterized queries via SQLAlchemy (no raw SQL),
  input validation via Pydantic.
- **Responsive design**: desktop, tablet, and mobile layouts (mobile collapses to a
  single-pane view with a back button).
- **Performance**: paginated + infinite-scroll message history, lazy message loading,
  and id-based message de-duplication so the same message is never rendered twice
  even though it can now legitimately arrive from more than one place (an optimistic
  local update plus a WebSocket echo to your own other devices).

## ⚠️ Explicitly out of scope in this build

The original brief also asked for Stories, Polls, a GIF/sticker picker, message
translation, scheduled messages, and multi-device push sync. These are each
substantial sub-projects on their own (a stories feed with expiry, a polls data
model and UI, third-party GIF API integration, a job scheduler, etc.). Rather than
ship placeholder buttons that don't do anything, they've been left out so that
everything you *do* see in the app is real and working. See **Future Improvements**
below for what each would take.

---

## Project Structure

```
Messenger/
├── backend/
│   ├── main.py              # FastAPI app, WebSocket endpoint (messages + call signalling), static file serving
│   ├── database.py          # SQLAlchemy engine/session config (SQLite)
│   ├── models.py            # ORM models: User, Chat, ChatMember, Message, Attachment,
│   │                          Reaction, MessageReceipt, MessageDeletion, BlockedUser,
│   │                          Notification
│   ├── schemas.py           # Pydantic request/response schemas
│   ├── auth.py              # JWT + bcrypt helpers
│   ├── websocket_manager.py # Tracks active WebSocket connections, broadcasts events
│   ├── call_manager.py      # In-memory WebRTC call state (busy tracking, disconnect cleanup)
│   └── routers/
│       ├── auth.py          # /api/auth/*
│       ├── users.py         # /api/users/*
│       ├── chats.py         # /api/chats/*
│       ├── messages.py      # /api/messages/*
│       ├── uploads.py       # /api/uploads/* (broadcasts message_attachment on upload)
│       └── notifications.py # /api/notifications/*
├── frontend/
│   ├── index.html           # Login / Register / Forgot password
│   ├── chat.html             # Main application shell (incl. call overlays)
│   ├── css/style.css         # Full design system (glassmorphism, themes, responsive, calls)
│   └── js/
│       ├── api.js            # fetch() wrapper + token storage
│       ├── auth.js           # Login/register page logic
│       ├── websocket.js       # WebSocket client with auto-reconnect
│       ├── ui.js              # Toasts, modals, formatting helpers, emoji data
│       ├── calls.js           # WebRTC audio/video calling (signalling + media + call UI)
│       └── chat.js            # All core application logic
├── database/                 # messenger.db (SQLite) is created here on first run
├── uploads/                  # Uploaded files are stored here
├── requirements.txt
└── README.md
```

---

## Installation & Running

### Requirements
- Python 3.13 (tested against this version; 3.10+ should still work since
  nothing in the code is 3.13-only)
- A modern browser (Chrome, Firefox, Edge, Safari)

### 1. Install backend dependencies

```bash
cd Messenger
python3 -m venv venv
source venv/bin/activate        # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Run the backend (also serves the frontend)

```bash
cd backend
uvicorn main:app --reload --port 8000
```

The database tables are created automatically in `database/messenger.db` on first run.

### 3. Open the app

Go to **http://127.0.0.1:8000** in your browser. That single origin serves:
- the login/register page (`/`)
- the chat app (`/chat.html`)
- the REST API (`/api/*`)
- the WebSocket endpoint (`/ws`)
- uploaded files (`/uploads/*`)

Open the URL in two different browsers (or one normal + one incognito window),
register two different accounts, and start chatting — messages, typing indicators,
and presence all update in real time between the two.

There is no separate frontend server or build step required — it's static HTML/CSS/JS
served directly by FastAPI.

---

## API Overview

All endpoints are prefixed `/api` and (except register/login) require
`Authorization: Bearer <token>`.

| Area          | Endpoints |
|---------------|-----------|
| Auth          | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Users         | `GET /users/search?q=`, `GET /users/{id}`, `PUT /users/me`, `PUT /users/me/password`, `POST /users/block`, `POST /users/unblock`, `GET /users/me/blocked` |
| Chats         | `GET /chats`, `POST /chats`, `GET /chats/{id}`, `PUT /chats/{id}/pin`, `PUT /chats/{id}/archive`, `PUT /chats/{id}/read`, `PUT /chats/{id}/group`, `POST /chats/{id}/members`, `DELETE /chats/{id}/members/{user_id}`, `PUT /chats/{id}/members/{user_id}/admin` |
| Messages      | `GET /messages/{chat_id}`, `POST /messages`, `PUT /messages/{id}`, `DELETE /messages/{id}?for_everyone=`, `POST /messages/{id}/reactions`, `GET /messages/search/{chat_id}?q=` |
| Uploads       | `POST /uploads/attachment/{message_id}`, `POST /uploads/avatar`, `POST /uploads/cover`, `POST /uploads/group-icon/{chat_id}` |
| Notifications | `GET /notifications`, `PUT /notifications/{id}/read`, `PUT /notifications/read-all` |
| WebSocket     | `GET /ws?token=<jwt>` — events: `new_message`, `message_edited`, `message_deleted`, `message_reaction`, `typing`, `stop_typing`, `presence` |

Interactive API docs (Swagger UI) are auto-generated by FastAPI at
**http://127.0.0.1:8000/docs**.

---

## Database Tables

`users`, `chats`, `chat_members`, `messages`, `attachments`, `reactions`,
`message_receipts`, `message_deletions`, `blocked_users`, `notifications`.
Groups are modeled as a `Chat` with `type="group"`, so there is no separate
`groups` table — group name/description/icon live on `chats`, and admin flags
live on `chat_members`.

---

## Future Improvements

- **Audio/video calls (WebRTC)** — needs a signaling channel (can reuse the existing
  WebSocket for offer/answer/ICE exchange) plus a STUN/TURN server for NAT traversal.
- **Stories/Status** — a new `stories` table with an expiry timestamp, a background
  cleanup job, and a horizontally-scrolling tray UI.
- **Polls** — a `polls` + `poll_options` + `poll_votes` schema and a message subtype
  that renders an interactive vote UI instead of text.
- **GIF/sticker picker** — integrate a provider (e.g. Tenor/GIPHY API) behind a
  proxy endpoint so API keys aren't exposed client-side.
- **Message translation** — call a translation API on demand and cache results
  per message/language.
- **Scheduled messages** — a `scheduled_messages` table plus a background worker
  (APScheduler or a cron-style task) that promotes them to real messages at send time.
- **Multi-device push** — service worker + Web Push subscriptions, or a mobile
  push provider (FCM/APNs) if wrapped as a native app.
- Migrate from SQLite to PostgreSQL and add Alembic migrations for production use.
- Add automated tests (pytest) for the API and a CI pipeline.
