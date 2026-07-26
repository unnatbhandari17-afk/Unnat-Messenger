"""
Tracks in-progress 1:1 calls so the WebSocket signalling layer (see
main.py) can:
  - reject a new call invite with "busy" if either party is already
    ringing/in a call, without waking up the callee's other devices
  - look up which user is on the other end of a call_id to relay
    SDP/ICE signalling messages
  - clean up and notify the remote peer if a participant's socket
    disconnects unexpectedly (network loss, tab closed, etc.)

This is intentionally a plain in-memory store: call state only needs to
survive for the lifetime of a single call and this process. The actual
audio/video never touches the server — only signalling messages do.
"""
from typing import Dict, Optional, Tuple


class CallState:
    __slots__ = ("call_id", "caller_id", "callee_id", "chat_id", "call_type", "accepted")

    def __init__(self, call_id: str, caller_id: int, callee_id: int, chat_id: int, call_type: str):
        self.call_id = call_id
        self.caller_id = caller_id
        self.callee_id = callee_id
        self.chat_id = chat_id
        self.call_type = call_type
        self.accepted = False

    def peer_of(self, user_id: int) -> Optional[int]:
        if user_id == self.caller_id:
            return self.callee_id
        if user_id == self.callee_id:
            return self.caller_id
        return None


class CallManager:
    def __init__(self):
        self.calls: Dict[str, CallState] = {}     # call_id -> CallState
        self.user_call: Dict[int, str] = {}        # user_id -> call_id (ringing or active)

    def is_busy(self, user_id: int) -> bool:
        return user_id in self.user_call

    def create_call(self, call_id: str, caller_id: int, callee_id: int, chat_id: int, call_type: str) -> CallState:
        state = CallState(call_id, caller_id, callee_id, chat_id, call_type)
        self.calls[call_id] = state
        self.user_call[caller_id] = call_id
        self.user_call[callee_id] = call_id
        return state

    def get(self, call_id: str) -> Optional[CallState]:
        return self.calls.get(call_id)

    def accept(self, call_id: str):
        state = self.calls.get(call_id)
        if state:
            state.accepted = True

    def end_call(self, call_id: str) -> Optional[CallState]:
        state = self.calls.pop(call_id, None)
        if state:
            if self.user_call.get(state.caller_id) == call_id:
                self.user_call.pop(state.caller_id, None)
            if self.user_call.get(state.callee_id) == call_id:
                self.user_call.pop(state.callee_id, None)
        return state

    def end_calls_for_user(self, user_id: int) -> Tuple[Optional[int], Optional[str]]:
        """Called when a user's socket disconnects. Ends any call they were
        part of and returns (peer_id, call_id) so the caller can notify the
        other participant, or (None, None) if they weren't in a call."""
        call_id = self.user_call.get(user_id)
        if not call_id:
            return None, None
        state = self.end_call(call_id)
        if not state:
            return None, None
        return state.peer_of(user_id), state.call_id


call_manager = CallManager()
