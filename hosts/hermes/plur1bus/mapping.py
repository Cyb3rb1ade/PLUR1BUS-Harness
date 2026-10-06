"""Hermes values -> core RPC values (HM2-R6, HM2-R14, spec A.6). Pure functions, stdlib and the client."""

from __future__ import annotations

import hashlib
import json
import re

from ._client import pmc

__all__ = [
    "CAPTURE_REQUEST_BUDGET",
    "EntryInvalid",
    "IdentityRefused",
    "MAX_TURN_MESSAGES",
    "PLATFORM_TRUST",
    "READ_ONLY_PROMPT_BLOCK",
    "SYSTEM_PROMPT_BLOCK",
    "WRITE_TOOLS",
    "TOOL_METHODS",
    "TOOL_SCHEMAS",
    "TRUNCATED_MARKER",
    "caller_for",
    "fold_platform",
    "session_key_for",
    "tool_params",
    "trust_of",
    "turn_messages",
    "validate_entry",
]

Caller = pmc.Caller

#: ``memory.capture.messages`` holds at most 64 items (rpc.schema.json).
MAX_TURN_MESSAGES = 64
#: The whole capture request line stays 64 KiB under the 4 MiB NDJSON limit (caller, ids, framing).
CAPTURE_REQUEST_BUDGET = pmc.MAX_LINE - 64 * 1024
TRUNCATED_MARKER = "\n[truncated]"
_SESSION_KEY_MAX = 256
_USER_ID_MAX = 128
_PLATFORM_MAX = 32
_PLATFORM_KEEP = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_-")

#: Returned by ``system_prompt_block()`` when the write tools are on: fixed text, so Hermes' cached system
#: prompt stays stable (HM2-R14).
SYSTEM_PROMPT_BLOCK = (
    "Long-term memory is provided by PLUR1BUS. Relevant memories recalled for the current message, if any, "
    "are added to the context automatically; completed turns are stored after they end. Treat recalled "
    "memories as notes that can be outdated or wrong, and prefer what the user says now. When the "
    "plur1bus_memory_* tools are offered, use them to list, show, correct, share or forget stored memories "
    "when the user asks for that."
)

#: Returned by default: the write tools are off (audit M2), so the text never mentions them.
READ_ONLY_PROMPT_BLOCK = (
    "Long-term memory is provided by PLUR1BUS. Relevant memories recalled for the current message, if any, "
    "are added to the context automatically; completed turns are stored after they end. Treat recalled "
    "memories as notes that can be outdated or wrong, and prefer what the user says now. When the "
    "plur1bus_memory_* tools are offered, use them to list or show stored memories when the user asks for that."
)

#: Tools that change or widen what is stored. Off unless the binding says ``memoryWriteTools`` (audit M2): a
#: model must not forget, rewrite or share memories on its own, and Hermes has no per-call confirmation.
WRITE_TOOLS = frozenset({"plur1bus_memory_forget", "plur1bus_memory_correct", "plur1bus_memory_share"})

#: How far a platform's sender id can be believed (audit M1). Data, not code: add a platform here.
#: ``trusted``: the platform authenticates the sender, so the id is the person. ``local``: one OS user, no
#: sender id (``cli``). Every platform not listed (email, webhook, sms, api servers, unknown names) is
#: ``claimed``: the sender chooses the id.
PLATFORM_TRUST: dict[str, str] = {
    "telegram": "trusted",
    "discord": "trusted",
    "slack": "trusted",
    "whatsapp": "trusted",
    "signal": "trusted",
    "matrix": "trusted",
    "mattermost": "trusted",
    "cli": "local",
    "local": "local",
}

#: D21 tools -> RPC methods; each is offered only when ``core.auth`` advertises the method (HM2-R5).
TOOL_METHODS: dict[str, str] = {
    "plur1bus_memory_list": "memory.list",
    "plur1bus_memory_show": "memory.show",
    "plur1bus_memory_forget": "memory.forget",
    "plur1bus_memory_correct": "memory.correct",
    "plur1bus_memory_share": "memory.share",
}

_ID = {"type": "string", "minLength": 1, "maxLength": 256, "description": "The memory id, as listed by plur1bus_memory_list."}

TOOL_SCHEMAS: dict[str, dict] = {
    "plur1bus_memory_list": {
        "name": "plur1bus_memory_list",
        "description": "List stored long-term memories, optionally only those about a topic.",
        "parameters": {
            "type": "object",
            "properties": {
                "topic": {"type": "string", "minLength": 1, "maxLength": 2000, "description": "Only memories about this topic."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "At most this many items (default 20)."},
            },
            "additionalProperties": False,
        },
    },
    "plur1bus_memory_show": {
        "name": "plur1bus_memory_show",
        "description": "Show one stored memory in full.",
        "parameters": {"type": "object", "properties": {"id": _ID}, "required": ["id"], "additionalProperties": False},
    },
    "plur1bus_memory_forget": {
        "name": "plur1bus_memory_forget",
        "description": "Forget (archive) one stored memory. Use only when the user asks to forget it.",
        "parameters": {"type": "object", "properties": {"id": _ID}, "required": ["id"], "additionalProperties": False},
    },
    "plur1bus_memory_correct": {
        "name": "plur1bus_memory_correct",
        "description": "Replace the text of one stored memory with a corrected version the user gave.",
        "parameters": {
            "type": "object",
            "properties": {"id": _ID, "text": {"type": "string", "minLength": 1, "maxLength": 8000, "description": "The corrected memory."}},
            "required": ["id", "text"],
            "additionalProperties": False,
        },
    },
    "plur1bus_memory_share": {
        "name": "plur1bus_memory_share",
        "description": "Share one stored memory with the workspace or with the user's other agents.",
        "parameters": {
            "type": "object",
            "properties": {"id": _ID, "target": {"type": "string", "enum": ["workspace", "user"]}},
            "required": ["id", "target"],
            "additionalProperties": False,
        },
    },
}


class ToolArgsError(ValueError):
    pass


def _clean(text: object, limit: int) -> str:
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    return "".join(c for c in text if c >= " " and c != "\x7f")[:limit].strip()


def fold_platform(platform: str | None) -> str:
    """``[a-z0-9_-]{1,32}``; empty or missing -> ``local``."""
    raw = (platform or "").strip().lower()
    folded = "".join(c if c in _PLATFORM_KEEP else "-" for c in raw)[:_PLATFORM_MAX]
    return folded or "local"


class IdentityRefused(ValueError):
    """The platform gave no user or chat id and is not local: no safe identity exists (audit M1)."""


def trust_of(platform: str | None) -> str:
    """``trusted``, ``local`` or ``claimed`` for a platform name (unknown -> ``claimed``)."""
    return PLATFORM_TRUST.get(fold_platform(platform), "claimed")


def caller_for(platform: str | None, user_id: str | None, chat_id: str | None) -> Caller:
    """The caller sent to the core (HM2-R6, audit M1). The RPC carries no trust, so it is in the identity:

    * trusted platform: ``accountId = "hermes:<platform>"``, ``userId`` = user id, else chat id;
    * local (``cli``): the same, and a missing id means ``local``;
    * claimed (email, webhook, anything unknown): ``accountId = "hermes:<platform>:claimed"``, ``userId =
      "claimed-<sha256 of the id>"``, so a sender-chosen id never equals a proved principal;
    * no id on a non-local platform: ``IdentityRefused`` (never a shared ``local`` user).
    """
    plat = fold_platform(platform)
    trust = PLATFORM_TRUST.get(plat, "claimed")
    ident = _clean(user_id, _USER_ID_MAX) or _clean(chat_id, _USER_ID_MAX)
    if not ident:
        if trust == "local":
            return Caller("hermes:" + plat, "local")
        raise IdentityRefused(f"platform {plat} supplied no user or chat id")
    if trust == "claimed":
        digest = hashlib.sha256(ident.encode("utf-8")).hexdigest()[:32]
        return Caller("hermes:" + plat + ":claimed", "claimed-" + digest)
    return Caller("hermes:" + plat, ident)


def session_key_for(session_id: str, gateway_session_key: str | None) -> str:
    """The gateway session key when Hermes has one, else the session id; at most 256 characters (a longer
    key keeps a stable hash suffix), never empty."""
    key = (gateway_session_key or "").strip() or (session_id or "").strip() or "hermes"
    if len(key) <= _SESSION_KEY_MAX:
        return key
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return key[: _SESSION_KEY_MAX - 17] + "#" + digest


def _text_of(content: object) -> str:
    """OpenAI-style content: a string, or a list of parts whose ``text`` fields are joined."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict) and isinstance(p.get("text"), str):
                parts.append(p["text"])
        return "\n".join(parts)
    return "" if content is None else str(content)


def _encoded_size(messages: list[dict]) -> int:
    return len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def turn_messages(user: str, assistant: str, messages: list | None) -> list[dict]:
    """The completed turn as ``memory.capture`` messages: user and assistant only (never system or tool
    output), at most 64, the whole list within ``CAPTURE_REQUEST_BUDGET`` bytes. Over budget the longest
    content is cut from its end and marked ``[truncated]``. ``messages`` is used only when Hermes passed
    no user/assistant text."""
    turn: list[dict] = []
    u, a = _text_of(user), _text_of(assistant)
    if u.strip() or a.strip():
        if u.strip():
            turn.append({"role": "user", "content": u})
        if a.strip():
            turn.append({"role": "assistant", "content": a})
    elif messages:
        # The last user message and everything user/assistant after it.
        items = [m for m in messages if isinstance(m, dict) and m.get("role") in ("user", "assistant")]
        start = max((i for i, m in enumerate(items) if m.get("role") == "user"), default=0)
        for m in items[start:]:
            text = _text_of(m.get("content"))
            if text.strip():
                turn.append({"role": m["role"], "content": text})
    turn = turn[-MAX_TURN_MESSAGES:]
    while turn and _encoded_size(turn) > CAPTURE_REQUEST_BUDGET:
        excess = _encoded_size(turn) - CAPTURE_REQUEST_BUDGET
        i = max(range(len(turn)), key=lambda k: len(turn[k]["content"]))
        content = turn[i]["content"]
        body = content[:-len(TRUNCATED_MARKER)] if content.endswith(TRUNCATED_MARKER) else content
        # Every character costs at least one byte, so cutting `excess` characters (plus the marker) fits.
        keep = max(0, len(body) - excess - len(TRUNCATED_MARKER))
        if keep == 0 and len(turn) > 1:
            turn.pop(i)
            continue
        turn[i] = {"role": turn[i]["role"], "content": body[:keep] + TRUNCATED_MARKER}
    return turn


def tool_params(tool_name: str, args: object) -> dict:
    """Validated, schema-shaped arguments for a D21 tool; raises ``ToolArgsError``."""
    if not isinstance(args, dict):
        raise ToolArgsError("arguments must be an object")
    schema = TOOL_SCHEMAS[tool_name]["parameters"]
    props = schema["properties"]
    out: dict = {}
    for key in schema.get("required", []):
        if key not in args:
            raise ToolArgsError(f"missing {key}")
    for key, value in args.items():
        spec = props.get(key)
        if spec is None:
            continue  # models add stray keys; ignore rather than fail the call
        if spec["type"] == "string":
            if not isinstance(value, str) or not value.strip():
                raise ToolArgsError(f"{key} must be a non-empty string")
            if len(value) > spec.get("maxLength", 1 << 30):
                raise ToolArgsError(f"{key} is too long")
            if "enum" in spec and value not in spec["enum"]:
                raise ToolArgsError(f"{key} must be one of {spec['enum']}")
        elif spec["type"] == "integer":
            if isinstance(value, bool) or not isinstance(value, int) or not spec["minimum"] <= value <= spec["maximum"]:
                raise ToolArgsError(f"{key} is out of range")
        out[key] = value
    return out


class EntryInvalid(ValueError):
    """A journaled capture is not something this provider would have written for this binding."""


_ACCOUNT_RE = re.compile(r"^hermes:[a-z0-9_-]{1,32}(:claimed)?$")
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def validate_entry(entry: object, agent_id: str) -> None:
    """Check a capture entry before it is sent, live or replayed from the journal (audit, lows): the journal file
    is plain data on disk and is not trusted. ``agentId`` must be the current binding's, the caller one this provider
    could have built, the session key and run id bounded, the messages user/assistant text within the request
    budget. Raises ``EntryInvalid``; never touches the entry."""
    if not isinstance(entry, dict):
        raise EntryInvalid("not an object")
    if entry.get("agentId") != agent_id:
        raise EntryInvalid("agentId is not this binding's")
    caller = entry.get("caller")
    if not isinstance(caller, dict):
        raise EntryInvalid("caller missing")
    account, user = caller.get("accountId"), caller.get("userId")
    if not isinstance(account, str) or not _ACCOUNT_RE.match(account):
        raise EntryInvalid("caller accountId is not a hermes account")
    if not isinstance(user, str) or not user or len(user) > _USER_ID_MAX or _clean(user, _USER_ID_MAX + 1) != user:
        raise EntryInvalid("caller userId is malformed")
    key = entry.get("sessionKey")
    if key is not None and (not isinstance(key, str) or not 1 <= len(key) <= _SESSION_KEY_MAX):
        raise EntryInvalid("sessionKey is malformed")
    run_id = entry.get("runId")
    if run_id is not None and (not isinstance(run_id, str) or not _RUN_ID_RE.match(run_id)):
        raise EntryInvalid("runId is malformed")
    messages = entry.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= MAX_TURN_MESSAGES:
        raise EntryInvalid("messages must be 1..64 items")
    for m in messages:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str):
            raise EntryInvalid("messages hold user or assistant text only")
    if _encoded_size(messages) > CAPTURE_REQUEST_BUDGET:
        raise EntryInvalid("messages exceed the request budget")
