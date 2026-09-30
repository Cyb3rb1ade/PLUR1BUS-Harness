"""Scratch memory provider for the HM2 Task 1 spike (not shipped).

Logs every hook call Hermes makes, with its arguments, as one JSON line per
call to the file named by the ``SCRATCH_LOG`` environment variable. It makes
no network calls and stores nothing. ``is_available()`` returns False while
``SCRATCH_UNAVAILABLE=1`` is set.

The provider name is the directory name, so the same files can be copied to
``$HERMES_HOME/plugins/scratch/`` or ``$HERMES_HOME/plugins/plur1bus/``.
"""

import json
import os
import threading
import time

try:
    from agent.memory_provider import MemoryProvider
except ImportError:  # imported outside Hermes (e.g. by unittest discovery)
    MemoryProvider = object

_NAME = os.path.basename(os.path.dirname(os.path.abspath(__file__)))
_LOCK = threading.Lock()
_SEQ = [0]


def _summarise(value, depth=0):
    """JSON-safe copy; message lists are reduced to roles and lengths."""
    if depth > 4:
        return "<depth>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 200 else value[:200] + "...<%d chars>" % len(value)
    if isinstance(value, dict):
        return {str(k): _summarise(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        if value and all(isinstance(m, dict) and "role" in m for m in value):
            return {
                "messages": len(value),
                "roles": [m.get("role") for m in value],
            }
        return [_summarise(v, depth + 1) for v in value[:20]]
    return "<%s>" % type(value).__name__


def _log(hook, **fields):
    path = os.environ.get("SCRATCH_LOG")
    if not path:
        return
    with _LOCK:
        _SEQ[0] += 1
        rec = {
            "seq": _SEQ[0],
            "pid": os.getpid(),
            "t": round(time.time(), 3),
            "provider": _NAME,
            "hook": hook,
            "thread": threading.current_thread().name,
            "args": _summarise(fields),
        }
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, sort_keys=True) + "\n")


class ScratchProvider(MemoryProvider):
    @property
    def name(self):
        return _NAME

    def is_available(self):
        ok = os.environ.get("SCRATCH_UNAVAILABLE") != "1"
        _log("is_available", result=ok)
        return ok

    def unavailable_reason(self):
        _log("unavailable_reason")
        return "SCRATCH_UNAVAILABLE=1 is set"

    def initialize(self, session_id, **kwargs):
        _log("initialize", session_id=session_id, kwargs=kwargs,
             hermes_home_env=os.environ.get("HERMES_HOME"))

    def system_prompt_block(self):
        _log("system_prompt_block")
        return ""

    def prefetch(self, query, *, session_id=""):
        _log("prefetch", query=query, session_id=session_id)
        return ""

    def queue_prefetch(self, query, *, session_id=""):
        _log("queue_prefetch", query=query, session_id=session_id)

    def recall_status(self):
        _log("recall_status")
        return None

    def sync_turn(self, user_content, assistant_content, *, session_id="",
                  messages=None, turn_author=None):
        _log("sync_turn", user_content=user_content,
             assistant_content=assistant_content, session_id=session_id,
             messages=messages, turn_author=turn_author)

    def get_tool_schemas(self):
        _log("get_tool_schemas")
        return []

    def handle_tool_call(self, tool_name, args, **kwargs):
        _log("handle_tool_call", tool_name=tool_name, args=args, kwargs=kwargs)
        return json.dumps({"error": "scratch provider has no tools"})

    def shutdown(self):
        _log("shutdown")

    def on_turn_start(self, turn_number, message, **kwargs):
        _log("on_turn_start", turn_number=turn_number, message=message, kwargs=kwargs)

    def identity_signature(self):
        _log("identity_signature")
        return {}

    def on_session_end(self, messages):
        _log("on_session_end", messages=messages)

    def on_session_switch(self, new_session_id, *, parent_session_id="",
                          reset=False, rewound=False, **kwargs):
        _log("on_session_switch", new_session_id=new_session_id,
             parent_session_id=parent_session_id, reset=reset, rewound=rewound,
             kwargs=kwargs)

    def on_pre_compress(self, messages):
        _log("on_pre_compress", messages=messages)
        return ""

    def on_delegation(self, task, result, *, child_session_id="", **kwargs):
        _log("on_delegation", task=task, result=result,
             child_session_id=child_session_id, kwargs=kwargs)

    def get_config_schema(self):
        _log("get_config_schema")
        return []

    def save_config(self, values, hermes_home):
        _log("save_config", values=values, hermes_home=hermes_home)

    def on_memory_write(self, action, target, content, metadata=None):
        _log("on_memory_write", action=action, target=target, content=content,
             metadata=metadata)

    def backup_paths(self):
        _log("backup_paths")
        return []


def register(ctx):
    _log("register")
    ctx.register_memory_provider(ScratchProvider())
