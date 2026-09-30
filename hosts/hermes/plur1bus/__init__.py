"""PLUR1BUS memory provider for Hermes (D88, spec A.6): a MemoryProvider that recalls and captures over
the local PLUR1BUS core's RPC. It holds no engine, store or model (D28 rule 1).

Hook mapping (HM2-R5, R12-R15, rulings F5, F6, F14):

* ``is_available`` checks files only: the binding parses and ``<home>/run/core.token`` is readable.
* ``initialize`` (1 s budget) reads the binding, maps the caller and session key, connects and warms
  the agent with ``agent.open`` when advertised. No binding -> inert, one warning.
* ``system_prompt_block`` returns fixed text; ``prefetch`` runs ``memory.recall`` within
  ``recallHardMs + 400 ms`` and returns ``""`` with one warning per session when the core is down.
* ``sync_turn`` queues the turn for one background worker (started with ``spawn_context_thread``),
  which captures in order (``wait=false``). A transport-class failure goes to the bounded journal,
  replayed before the next capture and after the next successful recall. Only ``agent_context ==
  "primary"`` is captured.
* ``on_pre_compress`` / ``on_session_end`` (2 s budget) wait for pending captures and checkpoint when
  advertised; ``on_session_end`` also closes the agent. ``shutdown`` (2 s budget) journals every turn
  the worker has not delivered by then.
* D21 tools (``plur1bus_memory_list|show|forget|correct|share``) only for advertised methods.

No hook does journal or state-file I/O except ``shutdown``, which uses a bounded lock and counts what it
could not write. The queued count and the last error live in memory; the worker writes them.

Tools and a core that is down at ``initialize``: Hermes asks for the tool list the model sees once,
right after ``initialize`` (``inject_memory_provider_tools``, ``agent/agent_init.py`` @ ``743ee72``), and
again only when it rebuilds its tool list (an MCP tool refresh). With no connection at that point no
D21 tool is offered; the list follows the live ``core.auth`` capabilities, so a later rebuild offers
them once the core is reachable, but in a plain session the tools stay off until the next session.

The token appears nowhere; message text appears only in the 0600 journal, never in log records.
"""

from __future__ import annotations

import collections
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
SHUTDOWN_BUDGET_S = 2.0
PRE_COMPRESS_WAIT_S = 2.0
PRE_COMPRESS_CALL_S = 1.0
CAPTURE_DEADLINE_S = 5.0
TOOL_DEADLINE_S = 5.0
#: The only context whose turns are captured (Hermes: skip automatic writes for non-primary contexts).
CAPTURE_CONTEXTS = frozenset({"primary"})
BIND_HINT = "run `hermes plur1bus bind` (or re-run the installer) to register this Hermes home with PLUR1BUS"

ClientFactory = Callable[[str], Any]


def _default_factory(home: str) -> Any:
    return pmc.MemoryClient(home)


def _code(exc: BaseException) -> str:
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) else type(exc).__name__


class _Inflight:
    """The entry the worker is sending; whoever claims it first (worker or shutdown) journals it."""

    __slots__ = ("entry", "claimed")

    def __init__(self, entry: dict) -> None:
        self.entry = entry
        self.claimed = False


class Plur1busMemoryProvider(MemoryProvider):
    """One instance per Hermes agent (per profile). ``client_factory(home)`` returns a ``MemoryClient``;
    tests pass one bound to a stub core. ``hermes_home`` overrides the home used before ``initialize``."""

    def __init__(self, *, client_factory: ClientFactory | None = None, hermes_home: str | None = None) -> None:
        self._factory = client_factory or _default_factory
        self._home_hint = hermes_home
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
        self._warn_lock = threading.Lock()
        self._warned: set[tuple[str, str]] = set()
        self._warning_callback: Callable[[str], Any] | None = None
        # Worker state, guarded by _cv.
        self._cv = threading.Condition(threading.Lock())
        self._items: collections.deque[dict] = collections.deque()
        self._inflight: _Inflight | None = None
        self._worker: threading.Thread | None = None
        self._closing = False
        self._stopped = False
        self._drain_wanted = True  # a journal left by an earlier process is replayed on first wake
        self._queued: int | None = None  # journal entries; None until the worker has looked
        self._last_error: str | None = None
        self._error_dirty = False
        self._lost = 0

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

    @property
    def lost(self) -> int:
        """Captures that could not be delivered or journaled (logged with the count, never text)."""
        return self._lost

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
        self._journal = CaptureJournal.for_home(self._hermes_home)  # no I/O until the worker uses it
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
        self._note_error(None, drain=True)
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
        if not self._active or self._agent_context not in CAPTURE_CONTEXTS:
            return
        b = self._binding
        assert b is not None
        if not b.capture:
            return
        turn = turn_messages(user_content, assistant_content, messages)
        if not turn:
            return
        entry = {"v": 1, "agentId": b.agent_id, "caller": self._caller.to_rpc(), "sessionKey": self._session_key, "messages": turn}
        with self._cv:
            if self._stopped:
                return
            self._items.append(entry)
            self._cv.notify_all()
        self._ensure_worker()

    def _ensure_worker(self) -> None:
        """Start the single capture worker once (thread start only; no I/O on the hook's thread)."""
        with self._cv:
            if self._worker is not None or self._stopped or self._journal is None:
                return
            self._worker = spawn_context_thread(self._worker_loop, name="plur1bus-capture")
            worker = self._worker
        worker.start()

    def _worker_loop(self) -> None:
        journal = self._journal
        assert journal is not None
        while True:
            with self._cv:
                while not (self._stopped or self._items or self._error_dirty or (self._drain_wanted and not self._closing)):
                    self._cv.wait()
                if self._stopped:
                    return
                write_error, code = self._error_dirty, self._last_error
                self._error_dirty = False
                want_drain = self._drain_wanted and not self._closing
                self._drain_wanted = False
                inflight = None
                if self._items:
                    inflight = self._inflight = _Inflight(self._items.popleft())
            if write_error:
                try:
                    journal.note_error(code)
                except Exception as e:  # noqa: BLE001 - status only
                    log.info("plur1bus: could not record the last error (%s)", type(e).__name__)
            if self._queued is None:
                try:
                    self._queued = journal.counts()["queued"]
                except OSError:
                    self._queued = 0
            if inflight is None:
                if want_drain and self._queued:
                    self._drain()
                continue
            try:
                self._process(inflight)
            finally:
                with self._cv:
                    self._inflight = None
                    self._cv.notify_all()

    def _process(self, inflight: _Inflight) -> None:
        entry = inflight.entry
        if self._queued and not self._closing:
            self._drain()
        if self._queued:
            self._journal_inflight(inflight)  # the core is still unreachable: keep the order, do not try
            return
        try:
            self._send_entry(entry)
        except Exception as e:  # noqa: BLE001 - classified: journal or drop
            code = _code(e)
            self._set_error(code)
            if is_journal_code(code):
                self._journal_inflight(inflight)
                if code == "E_AGENT_UNKNOWN":
                    self._warn("agent-unknown", f"plur1bus: agent {entry['agentId']} is not registered with PLUR1BUS ({code}); {BIND_HINT}")
                else:
                    self._warn("capture", f"plur1bus: memory capture is unavailable ({code}); turns are kept in the local journal and sent later")
            else:
                log.warning("plur1bus: the core refused a capture (%s); it was dropped", code)
                try:
                    self._journal.reject()
                except Exception:  # noqa: BLE001
                    pass
            self._flush_error()
            return
        self._set_error(None)
        self._flush_error()

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

    def _journal_inflight(self, inflight: _Inflight) -> None:
        with self._cv:
            if inflight.claimed:
                return  # shutdown journaled it already
            inflight.claimed = True
        self._journal_append([inflight.entry], timeout=10.0)

    def _journal_append(self, entries: list[dict], *, timeout: float) -> None:
        """Append in order; whatever cannot be written is counted and logged (never lost silently)."""
        journal = self._journal
        assert journal is not None
        for i, entry in enumerate(entries):
            try:
                journal.append(entry, timeout=timeout)
            except Exception as e:  # noqa: BLE001 - LockTimeout, OSError, ...
                self._count_lost(len(entries) - i, type(e).__name__)
                return
            self._queued = (self._queued or 0) + 1

    def _count_lost(self, n: int, why: str) -> None:
        self._lost += n
        log.warning("plur1bus: %d capture(s) could not be journaled (%s) and are lost", n, why)
        try:
            self._journal.bump(timeout=0.2, lost=n)
        except Exception:  # noqa: BLE001
            pass

    def _drain(self) -> None:
        journal = self._journal
        assert journal is not None
        try:
            journal.drain(self._send_entry)
            self._queued = journal.counts()["queued"]
        except Exception as e:  # noqa: BLE001 - retried on the next wake
            log.info("plur1bus: journal replay deferred (%s)", type(e).__name__)

    def _wait_idle(self, timeout: float) -> bool:
        """Wait until the worker has nothing queued or in flight (at most ``timeout`` seconds)."""
        end = time.monotonic() + max(0.0, timeout)
        with self._cv:
            while self._items or self._inflight is not None:
                left = end - time.monotonic()
                if left <= 0 or self._worker is None:
                    return False
                self._cv.wait(left)
        return True

    # -- checkpoints (HM2-R15) ----------------------------------------------------------------------

    def on_pre_compress(self, messages: list[dict[str, Any]]) -> str:
        if not self._active:
            return ""
        self._wait_idle(PRE_COMPRESS_WAIT_S)
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
        self._wait_idle(deadline - time.monotonic())
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
        """Deliver what the worker can within the budget, then journal every turn it has not delivered
        (bounded lock; what cannot be written is counted), then close the clients."""
        deadline = time.monotonic() + SHUTDOWN_BUDGET_S
        with self._cv:
            self._closing = True
            self._cv.notify_all()
        if self._worker is not None:
            self._wait_idle(deadline - time.monotonic() - 0.6)
        with self._cv:
            self._stopped = True
            leftover = list(self._items)
            self._items.clear()
            inflight = self._inflight
            self._cv.notify_all()
        if inflight is not None and self._wclient is not None:
            try:
                self._wclient.close(deadline_s=0.0)  # the call in flight fails fast; the worker journals it
            except Exception:  # noqa: BLE001
                pass
            worker = self._worker
            if worker is not None:
                worker.join(max(0.0, min(0.3, deadline - time.monotonic() - 0.2)))
            with self._cv:
                if not inflight.claimed and self._inflight is inflight:
                    inflight.claimed = True
                    leftover.insert(0, inflight.entry)
        if leftover:
            self._journal_append(leftover, timeout=max(0.05, deadline - time.monotonic()))
        for c in (self._rclient, self._wclient):
            if c is not None:
                try:
                    c.close(deadline_s=max(0.0, min(1.0, deadline - time.monotonic())))
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
        # Follows the live core.auth capabilities: empty while the core was never reached (see the
        # module docstring for when Hermes asks again).
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
        with self._warn_lock:
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

    def _set_error(self, code: str | None) -> bool:
        """Record the last error in memory; True when it changed (the worker persists it)."""
        with self._cv:
            if code == self._last_error:
                return False
            self._last_error = code
            self._error_dirty = True
            return True

    def _flush_error(self) -> None:
        """Worker only: write a changed last error now."""
        with self._cv:
            if not self._error_dirty:
                return
            self._error_dirty = False
            code = self._last_error
        try:
            self._journal.note_error(code)
        except Exception as e:  # noqa: BLE001
            log.info("plur1bus: could not record the last error (%s)", type(e).__name__)

    def _note_error(self, code: str | None, *, drain: bool = False) -> None:
        """Hook paths: memory only, then wake the worker (no journal or state I/O here)."""
        changed = self._set_error(code)
        wake = changed
        if drain:
            with self._cv:
                if self._queued is None or self._queued > 0:
                    self._drain_wanted = True
                    wake = True
        if wake and self._journal is not None:
            with self._cv:
                self._cv.notify_all()
            self._ensure_worker()


def register(ctx: Any) -> None:
    """Hermes entry point (``plugins/memory/__init__.py`` calls ``register(ctx)``)."""
    ctx.register_memory_provider(Plur1busMemoryProvider())
