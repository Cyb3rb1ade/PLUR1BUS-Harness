"""Test stub of Hermes' ``agent/memory_provider.py`` at ``743ee72`` (Hermes 0.21.4).

The signatures of ``MemoryProvider``, ``spawn_context_thread``, ``ctx_bound`` and the behaviour of
``is_trivial_prompt`` are copied from that file (Hermes is MIT licensed, Copyright (c) 2025 Nous
Research); docstrings are shortened. Only what the plur1bus provider touches is reproduced, plus the
hooks it overrides, so a signature drift shows up as a test failure. Tests put
``hosts/hermes/tests/stubs`` on ``sys.path``; the real module is used inside Hermes.
"""

from __future__ import annotations

import contextvars
import logging
import re
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


def ctx_bound(fn: Callable[..., Any]) -> Callable[..., Any]:
    ctx = contextvars.copy_context()
    return lambda *args, **kwargs: ctx.run(fn, *args, **kwargs)


def spawn_context_thread(target: Callable[..., Any], *, name: str, daemon: bool = True,
                         args: tuple = (), kwargs: Optional[Dict[str, Any]] = None) -> threading.Thread:
    return threading.Thread(target=ctx_bound(target), args=args, kwargs=kwargs, name=name, daemon=daemon)


PRE_COMPRESS_CHECKPOINT_API_VERSION = 2

INDICATOR_GLYPH = "\U0001f9e0"


@dataclass(frozen=True)
class RecallStatus:
    provider_label: str
    count: int
    glyph: str = INDICATOR_GLYPH


TRIVIAL_PROMPT_RE = re.compile(
    r'^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|'
    r'hi|hey|hello|yo|sup|'
    r'continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k)'
    r'[\s!?.:;,"' + "'" + r'~\u2018\u2019\u201c\u201d\u2014\u2013\u2026()\[\]{}<>*&^%$#@!+=`\u00a0]*$',
    re.IGNORECASE,
)


def is_trivial_prompt(text: Optional[str]) -> bool:
    stripped = (text or "").strip()
    if not stripped or stripped.startswith("/"):
        return True
    return bool(TRIVIAL_PROMPT_RE.match(stripped))


class MemoryProvider(ABC):
    pre_compress_checkpoint_api_version = 1

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def initialize(self, session_id: str, **kwargs) -> None: ...

    def unavailable_reason(self) -> str:
        return ""

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        pass

    def recall_status(self) -> Optional[RecallStatus]:
        return None

    def sync_turn(
        self, user_content: str, assistant_content: str, *,
        session_id: str = "", messages: Optional[List[Dict[str, Any]]] = None,
        turn_author: Optional[Dict[str, Any]] = None,
    ) -> None:
        pass

    @abstractmethod
    def get_tool_schemas(self) -> List[Dict[str, Any]]: ...

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        raise NotImplementedError(f"Provider {self.name} does not handle tool {tool_name}")

    def shutdown(self) -> None:
        pass

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        pass

    def identity_signature(self) -> Dict[str, Any]:
        return {}

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        pass

    def on_session_switch(
        self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False, rewound: bool = False, **kwargs,
    ) -> None:
        pass

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        return ""

    def on_delegation(self, task: str, result: str, *, child_session_id: str = "", **kwargs) -> None:
        pass

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return []

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        pass

    def on_memory_write(self, action: str, target: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        pass

    def backup_paths(self) -> List[str]:
        return []
