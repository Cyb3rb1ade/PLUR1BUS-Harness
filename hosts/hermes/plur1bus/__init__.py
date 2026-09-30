"""PLUR1BUS memory provider for Hermes (D88, spec A.6): a MemoryProvider that recalls and captures over
the local PLUR1BUS core's RPC. It holds no engine, store or model (D28 rule 1).

Hook mapping (HM2-R5, R12-R15, rulings F5, F6, F14):

* ``is_available`` checks files only: the binding parses and ``<home>/run/core.token`` is readable.
* ``initialize`` (1 s budget) reads the binding, maps the caller and session key, connects and warms
  the agent with ``agent.open`` when advertised. No binding -> inert, one warning.
* ``system_prompt_block`` returns fixed text; ``prefetch`` runs ``memory.recall`` within
  ``recallHardMs + 400 ms`` and returns ``""`` with one warning per session when the core is down.
* ``sync_turn`` captures in a ``spawn_context_thread`` thread (``wait=false``), in order; a
  transport-class failure goes to the bounded journal, replayed before the next capture and after the
  next successful recall.
* ``on_pre_compress`` / ``on_session_end`` (2 s budget) wait for the pending capture and checkpoint
  when advertised; ``on_session_end`` also closes the agent.
* D21 tools (``plur1bus_memory_list|show|forget|correct|share``) only for advertised methods.

The token appears nowhere; message text appears only in the 0600 journal, never in log records.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from agent.memory_provider import MemoryProvider, is_trivial_prompt, spawn_context_thread

from ._client import pmc
from .binding import Binding, BindingInvalid, read_binding, resolve_hermes_home
from .journal import CaptureJournal, is_journal_code
from .mapping import SYSTEM_PROMPT_BLOCK, TOOL_METHODS, TOOL_SCHEMAS, ToolArgsError, caller_for, session_key_for, tool_params, turn_messages

__all__ = ["Plur1busMemoryProvider", "register"]

log = logging.getLogger("plur1bus")

INITIALIZE_BUDGET_S = 1.0
SESSION_END_BUDGET_S = 2.0
PRE_COMPRESS_WAIT_S = 2.0
PRE_COMPRESS_CALL_S = 1.0
CAPTURE_DEADLINE_S = 5.0
TOOL_DEADLINE_S = 5.0
#: Contexts whose turns are not captured (Hermes: skip automatic writes for non-primary contexts).
SKIP_CAPTURE_CONTEXTS = frozenset({"cron", "subagent", "flush"})
BIND_HINT = "run `hermes plur1bus bind` (or re-run the installer) to register this Hermes home with PLUR1BUS"

ClientFactory = Callable[[str], Any]


def _default_factory(home: str) -> Any:
    return pmc.MemoryClient(home)


def _code(exc: BaseException) -> str:
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) else type(exc).__name__


class Plur1busMemoryProvider(MemoryProvider):
    """One instance per Hermes agent (per profile). ``client_factory(home)`` returns a ``MemoryClient``;
    tests pass one bound to a stub core. ``hermes_home`` overrides the home used before ``initialize``."""

    def __init__(self, *, client_factory: ClientFactory | None = None, hermes_home: str | None = None) -> None:
        self._factory = client_factory or _default_factory
        self._home_hint = hermes_home
        self._lock = threading.Lock()
        self._initialized = False
        self._binding: Binding | None = None
        self._hermes_home: str | None = None
        self._rclient: Any = None  # turn path, tools, agent open/close, checkpoint
        self._wclient: Any = None  # background captures and journal replay
        self._journal: CaptureJournal | None = None
        self._caller: Any = None
        self._session_key = ""
        self._session_id = ""
        self._agent_context = "primary"
        self._warned: set[tuple[str, str]] = set()
        self._warning_callback: Callable[[str], Any] | None = None
        self._last_sync: threading.Thread | None = None
        self._draining = False
        self._last_error: str | None = None

    # -- identity ---------------------------------------------------------------------------------

    @property
    def name(self) -> str:
        return "plur1bus"

    @property
    def binding(self) -> Binding | None:
        return self._binding

    @property
    def journal(self) -> CaptureJournal | None:
        return self._journal

    # -- availability (files only, HM2-R12) --------------------------------------------------------

    def _probe(self) -> tuple[bool, str]:
        home = resolve_hermes_home(self._home_hint)
        try:
            b = read_binding(home)
        except BindingInvalid as e:
            return False, f"the PLUR1BUS binding file is invalid ({e.reason}); {BIND_HINT}"
        if b is None:
            return False, f"this Hermes home has no PLUR1BUS binding; {BIND_HINT}"
        token = pmc.core_token_path(b.home)
        try:
            with open(token, "rb"):
                pass
        except OSError:
            return False, "the PLUR1BUS core is not running (no readable run/core.token); start it with `plur1bus daemon start`"
        return True, ""

    def is_available(self) -> bool:
        return self._probe()[0]

    def unavailable_reason(self) -> str:
        return self._probe()[1]

    # -- lifecycle --------------------------------------------------------------------------------

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        deadline = time.monotonic() + INITIALIZE_BUDGET_S
        self._initialized = True
        self._session_id = session_id or ""
        cb = kwargs.get("warning_callback")
        self._warning_callback = cb if callable(cb) else None
        self._agent_context = str(kwargs.get("agent_context") or "primary")
        home = kwargs.get("hermes_home") or resolve_hermes_home(self._home_hint)
        self._hermes_home = str(home)
        try:
            self._binding = read_binding(self._hermes_home)
        except BindingInvalid as e:
            self._binding = None
            self._warn("binding", f"plur1bus: the binding file is invalid ({e.reason}); memory is off for this session. {BIND_HINT}")
            return
        if self._binding is None:
            self._warn("binding", f"plur1bus: no binding for this Hermes home; memory is off for this session. {BIND_HINT}")
            return
        self._journal = CaptureJournal.for_home(self._hermes_home)
        self._caller = caller_for(kwargs.get("platform"), kwargs.get("user_id"), kwargs.get("chat_id"))
        self._session_key = session_key_for(self._session_id, kwargs.get("gateway_session_key"))
        self._rclient = self._factory(self._binding.home)
        self._wclient = self._factory(self._binding.home)
        try:
            self._rclient.connect(deadline_s=max(0.0, deadline - time.monotonic()))
            if self._rclient.supports("agent.open"):
                self._rclient.agent_open(self._binding.agent_id, deadline_s=max(0.0, deadline - time.monotonic()))
        except Exception as e:  # noqa: BLE001 - warm-up is optional; the turn path reports failures
            code = _code(e)
            self._note_error(code)
            if code == "E_AGENT_UNKNOWN":
                self._warn("agent-unknown", f"plur1bus: agent {self._binding.agent_id} is not registered with PLUR1BUS ({code}); {BIND_HINT}")
            else:
                log.info("plur1bus: warm-up at initialize failed (%s)", code)

    @property
    def _active(self) -> bool:
        return self._binding is not None and self._rclient is not None

    def system_prompt_block(self) -> str:
        return SYSTEM_PROMPT_BLOCK if self._active else ""

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False, rewound: bool = False, **kwargs: Any) -> None:
        self._session_id = new_session_id or self._session_id
        self._session_key = session_key_for(self._session_id, kwargs.get("gateway_session_key"))

    # -- recall (HM2-R14) -------------------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._active or is_trivial_prompt(query):
            return ""
        b = self._binding
        assert b is not None
        try:
            result = self._rclient.recall(
                self._caller,
                b.agent_id,
                query,
                session_key=self._session_key,
                hard_ms=b.recall_hard_ms,
                deadline_s=b.recall_hard_ms / 1000.0 + 0.4,
            )
        except Exception as e:  # noqa: BLE001 - a recall never fails a turn
            code = _code(e)
            self._note_error(code)
            if code == "E_AGENT_UNKNOWN":
                self._warn("agent-unknown", f"plur1bus: agent {b.agent_id} is not registered with PLUR1BUS ({code}); {BIND_HINT}")
            else:
                self._warn("recall", f"plur1bus: memory recall is unavailable ({code}); continuing without recalled memories")
            return ""
        self._note_error(None)
        self._kick_drain()
        joined = result.get("joined") if isinstance(result, dict) else None
        text = joined.get("text") if isinstance(joined, dict) else None
        return text if isinstance(text, str) else ""

    # -- capture (HM2-R13, F5) ----------------------------------------------------------------------

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: list[dict[str, Any]] | None = None,
        turn_author: dict[str, Any] | None = None,
    ) -> None:
        if not self._active or self._agent_context in SKIP_CAPTURE_CONTEXTS:
            return
        b = self._binding
        assert b is not None
        if not b.capture:
            return
        turn = turn_messages(user_content, assistant_content, messages)
        if not turn:
            return
        entry = {"v": 1, "agentId": b.agent_id, "caller": self._caller.to_rpc(), "sessionKey": self._session_key, "messages": turn}
        with self._lock:
            prev = self._last_sync
            t = spawn_context_thread(self._capture_job, name="plur1bus-capture", args=(entry, prev))
            self._last_sync = t
        t.start()

    def _send_entry(self, entry: dict) -> None:
        c = entry.get("caller") or {}
        caller = pmc.Caller(str(c.get("accountId") or "hermes:local"), str(c.get("userId") or "local"))
        self._wclient.capture(
            caller,
            str(entry["agentId"]),
            list(entry["messages"]),
            session_key=entry.get("sessionKey") or None,
            wait=False,
            deadline_s=CAPTURE_DEADLINE_S,
        )

    def _capture_job(self, entry: dict, prev: threading.Thread | None) -> None:
        if prev is not None:
            prev.join(CAPTURE_DEADLINE_S * 2)  # keep captures in turn order
        journal = self._journal
        assert journal is not None
        if journal.counts()["queued"]:
            journal.drain(self._send_entry)
            if journal.counts()["queued"]:
                journal.append(entry)  # the core is still unreachable: keep the order, do not try this one
                return
        try:
            self._send_entry(entry)
        except Exception as e:  # noqa: BLE001 - classified: journal or drop
            code = _code(e)
            self._note_error(code)
            if is_journal_code(code):
                journal.append(entry)
                if code == "E_AGENT_UNKNOWN":
                    self._warn("agent-unknown", f"plur1bus: agent {entry['agentId']} is not registered with PLUR1BUS ({code}); {BIND_HINT}")
                else:
                    self._warn("capture", f"plur1bus: memory capture is unavailable ({code}); turns are kept in the local journal and sent later")
            else:
                journal.reject()
                log.warning("plur1bus: the core refused a capture (%s); it was dropped", code)
            return
        self._note_error(None)
        if journal.counts()["queued"]:
            journal.drain(self._send_entry)

    def _kick_drain(self) -> None:
        journal = self._journal
        if journal is None or self._draining or not journal.counts()["queued"]:
            return
        self._draining = True

        def run() -> None:
            try:
                journal.drain(self._send_entry)
            finally:
                self._draining = False

        spawn_context_thread(run, name="plur1bus-replay").start()

    def _wait_for_sync(self, timeout: float) -> None:
        t = self._last_sync
        if t is not None and timeout > 0:
            t.join(timeout)

    # -- checkpoints (HM2-R15) ----------------------------------------------------------------------

    def on_pre_compress(self, messages: list[dict[str, Any]]) -> str:
        if not self._active:
            return ""
        self._wait_for_sync(PRE_COMPRESS_WAIT_S)
        if self._rclient.supports("memory.checkpoint"):
            try:
                self._rclient.checkpoint(self._caller, self._binding.agent_id, "compaction", deadline_s=PRE_COMPRESS_CALL_S)
            except Exception as e:  # noqa: BLE001 - best effort (checkpoint API v1)
                self._note_error(_code(e))
                log.info("plur1bus: checkpoint before compression failed (%s)", _code(e))
        return ""

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:
        if not self._active:
            return
        deadline = time.monotonic() + SESSION_END_BUDGET_S
        self._wait_for_sync(deadline - time.monotonic())
        agent = self._binding.agent_id
        for method, call in (
            ("memory.checkpoint", lambda left: self._rclient.checkpoint(self._caller, agent, "session-end", deadline_s=left)),
            ("agent.close", lambda left: self._rclient.agent_close(agent, deadline_s=left)),
        ):
            left = deadline - time.monotonic()
            if left <= 0.05 or not self._rclient.supports(method):
                continue
            try:
                call(left)
            except Exception as e:  # noqa: BLE001 - best effort at session end
                self._note_error(_code(e))
                log.info("plur1bus: %s at session end failed (%s)", method, _code(e))

    def shutdown(self) -> None:
        for c in (self._rclient, self._wclient):
            if c is not None:
                try:
                    c.close(deadline_s=1.0)
                except Exception:  # noqa: BLE001
                    pass

    # -- D21 tools --------------------------------------------------------------------------------

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        if not self._initialized:
            # Hermes builds its tool routing table in add_provider(), before initialize() and before any
            # connection (agent/memory_manager.py @ 743ee72). Offer every tool there; the list the model
            # sees is asked again after initialize() and holds only the advertised ones.
            return [dict(s) for s in TOOL_SCHEMAS.values()]
        if not self._active:
            return []
        return [dict(TOOL_SCHEMAS[t]) for t, m in TOOL_METHODS.items() if self._rclient.supports(m)]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        method = TOOL_METHODS.get(tool_name)
        if method is None or not self._active or not self._rclient.supports(method):
            return json.dumps({"error": "E_NOT_AVAILABLE"})
        try:
            p = tool_params(tool_name, args)
        except ToolArgsError:
            return json.dumps({"error": "E_INVALID_PARAMS"})
        c, agent, d = self._rclient, self._binding.agent_id, TOOL_DEADLINE_S
        try:
            if method == "memory.list":
                result = c.memory_list(self._caller, agent, topic=p.get("topic"), limit=p.get("limit", 20), deadline_s=d)
            elif method == "memory.show":
                result = c.memory_show(self._caller, agent, p["id"], deadline_s=d)
            elif method == "memory.forget":
                result = c.memory_forget(self._caller, agent, p["id"], deadline_s=d)
            elif method == "memory.correct":
                result = c.memory_correct(self._caller, agent, p["id"], p["text"], deadline_s=d)
            else:
                result = c.memory_share(self._caller, agent, p["id"], p["target"], deadline_s=d)
        except Exception as e:  # noqa: BLE001 - tools report E_* codes, never raise into Hermes
            code = _code(e)
            self._note_error(code)
            return json.dumps({"error": code})
        return json.dumps(result, ensure_ascii=False)

    # -- config (the installer writes the binding) ---------------------------------------------------

    def get_config_schema(self) -> list[dict[str, Any]]:
        return []

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        return None

    # -- helpers ----------------------------------------------------------------------------------

    def _warn(self, kind: str, message: str) -> None:
        """One warning per kind and session. Messages carry codes and hints, never text or the token."""
        key = (self._session_id, kind)
        with self._lock:
            if key in self._warned:
                return
            self._warned.add(key)
        log.warning("%s", message)
        cb = self._warning_callback
        if cb is not None:
            try:
                cb(message)
            except Exception:  # noqa: BLE001
                pass

    def _note_error(self, code: str | None) -> None:
        if code == self._last_error:
            return
        self._last_error = code
        journal = self._journal
        if journal is not None:
            try:
                journal.note_error(code)
            except OSError:
                pass


def register(ctx: Any) -> None:
    """Hermes entry point (``plugins/memory/__init__.py`` calls ``register(ctx)``)."""
    ctx.register_memory_provider(Plur1busMemoryProvider())

