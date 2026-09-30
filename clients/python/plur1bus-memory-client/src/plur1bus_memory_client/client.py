"""``MemoryClient``: the core RPC over the home's socket or pipe, for host adapters (spec A.6, D88).

Every (re)connect re-reads ``run/core.token`` and ``run/core.pid``, checks the OS-reported server pid
against ``run/core.pid`` before the token is sent (ruling S11) and, on POSIX, refuses a ``run/`` that is
not a directory owned by this user without group/other write bits (HM2-R7). Every call runs under one
monotonic deadline that covers connecting, sending, receiving and the single reconnect (F14).
"""

from __future__ import annotations

import os
import stat
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .paths import core_address, core_pid_path, core_token_path, is_absolute_home, run_dir
from .protocol import RpcError, encode_request, parse_rpc_version, read_response

__all__ = [
    "Caller",
    "MemoryClient",
    "RETRYABLE_METHODS",
    "RECALL_QUERY_MAX_CHARS",
    "RPC_MAJOR",
    "RPC_MIN_MINOR",
]

#: Methods a call on a broken connection re-sends once after reconnecting; everything else (capture,
#: forget, correct, share, checkpoint) is never re-sent, the caller decides.
RETRYABLE_METHODS = frozenset(
    {"core.status", "memory.recall", "memory.list", "memory.show", "agent.open", "agent.close", "agent.status", "agent.list"}
)
#: ``memory.recall.query`` is capped at 32768 characters by the schema; longer queries keep their tail (F15).
RECALL_QUERY_MAX_CHARS = 32000
#: The client speaks rpc major 1 from minor 3 on (the HM2 baseline); other majors are ``E_RPC_VERSION``.
RPC_MAJOR = 1
RPC_MIN_MINOR = 3

_STREAM_FAULTS = frozenset({"E_TRANSPORT", "E_TIMEOUT", "E_PROTOCOL"})
_HEX = frozenset("0123456789abcdefABCDEF")

TransportFactory = Callable[..., Any]


@dataclass(frozen=True)
class Caller:
    """What the host knows about the caller (``CallerIdentity``; the channel is always ``cli``, HM2-R6)."""

    account_id: str
    user_id: str

    def to_rpc(self) -> dict:
        return {"channel": "cli", "accountId": self.account_id, "userId": self.user_id}


def _default_factory(platform: str) -> TransportFactory:
    """``transport_win.open_stream`` on ``win32`` (imported lazily, so POSIX never loads it), else
    ``transport_posix.open_stream``."""
    if platform == "win32":

        def open_windows(address: str, *, connect_timeout: float) -> Any:
            from . import transport_win

            return transport_win.open_stream(address, connect_timeout=connect_timeout)

        return open_windows
    from .transport_posix import open_stream

    return open_stream


class MemoryClient:
    """A blocking, thread-safe client for one PLUR1BUS home (calls are serialised on one connection)."""

    def __init__(
        self,
        home: str,
        *,
        platform: str = sys.platform,
        connect_timeout: float = 2.0,
        call_timeout: float = 5.0,
        transport_factory: TransportFactory | None = None,
    ) -> None:
        if not is_absolute_home(home, platform):
            raise ValueError("home must be an absolute path (pass the exact home the core runs with)")
        self.home = home
        self.platform = platform
        self.address = core_address(home, platform)
        self.connect_timeout = float(connect_timeout)
        self.call_timeout = float(call_timeout)
        self._factory = transport_factory or _default_factory(platform)
        self._lock = threading.Lock()
        self._stream: Any = None
        self._hello: dict | None = None
        self._next_id = 1
        self._close_gen = 0

    # -- connection -------------------------------------------------------------------------------

    @property
    def hello(self) -> dict | None:
        """The last ``core.auth`` result (never contains the token)."""
        return dict(self._hello) if self._hello is not None else None

    def connect(self, *, deadline_s: float | None = None) -> dict:
        """(Re)connect: read token and pid, S11 check, ``core.auth``; returns the ``core.auth`` result."""
        deadline = time.monotonic() + (self.connect_timeout if deadline_s is None else deadline_s)
        with self._locked(deadline):
            return dict(self._connect_locked(deadline))

    def supports(self, method: str) -> bool:
        """Whether the connected core's ``core.auth`` capabilities list ``method`` (False before a connect)."""
        caps = (self._hello or {}).get("capabilities")
        methods = caps.get("methods") if isinstance(caps, dict) else None
        return isinstance(methods, dict) and method in methods

    def close(self, *, deadline_s: float = 1.0) -> None:
        """Close the connection. Waits at most ``deadline_s`` (default 1 s, inside F14's 2 s session-end
        budget) for an in-flight call; past that the connection is shut down under it, and that call fails
        with ``E_TRANSPORT`` (reason ``closed``) without a retry."""
        self._close_gen += 1
        if self._lock.acquire(timeout=max(0.0, deadline_s)):
            try:
                self._drop_locked()
            finally:
                self._lock.release()
            return
        stream = self._stream
        if stream is not None:
            try:
                stream.close()
            except Exception:  # noqa: BLE001 - best effort
                pass

    def __enter__(self) -> MemoryClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"MemoryClient(home={self.home!r}, connected={self._stream is not None})"

    # -- methods ----------------------------------------------------------------------------------

    def status(self, *, deadline_s: float | None = None) -> dict:
        return self._call("core.status", {}, deadline_s)

    def recall(
        self,
        caller: Caller,
        agent_id: str,
        query: str,
        *,
        session_key: str | None = None,
        hard_ms: int | None = None,
        joined: bool = True,
        deadline_s: float | None = None,
    ) -> dict:
        """``memory.recall``. The query keeps its last ``RECALL_QUERY_MAX_CHARS`` characters. Without
        ``deadline_s`` the deadline is ``hard_ms + 400 ms`` (HM2-R14), or ``call_timeout``."""
        if not isinstance(query, str) or not query:
            raise RpcError("E_INVALID_PARAMS", "recall needs a non-empty query", {"reason": "empty-query"})
        params: dict = {"caller": caller.to_rpc(), "agentId": agent_id, "query": query[-RECALL_QUERY_MAX_CHARS:]}
        if session_key is not None:
            params["sessionKey"] = session_key
        if hard_ms is not None:
            params["budget"] = {"hardMs": int(hard_ms)}
            if deadline_s is None:
                deadline_s = int(hard_ms) / 1000.0 + 0.4
        params["joined"] = bool(joined)
        return self._call("memory.recall", params, deadline_s)

    def capture(
        self,
        caller: Caller,
        agent_id: str,
        messages: list[dict],
        *,
        session_key: str | None = None,
        run_id: str | None = None,
        wait: bool = False,
        deadline_s: float | None = None,
    ) -> dict:
        """``memory.capture``; never re-sent automatically. With ``wait`` the server wait fits the deadline."""
        params: dict = {"caller": caller.to_rpc(), "agentId": agent_id, "messages": list(messages)}
        if session_key is not None:
            params["sessionKey"] = session_key
        if run_id is not None:
            params["runId"] = run_id
        params["wait"] = bool(wait)
        if wait:
            budget = self.call_timeout if deadline_s is None else deadline_s
            params["waitMs"] = max(1, min(120000, int(budget * 1000) - 250))
        return self._call("memory.capture", params, deadline_s)

    def checkpoint(self, caller: Caller, agent_id: str, reason: str, *, deadline_s: float | None = None) -> dict:
        params = {"caller": caller.to_rpc(), "agentId": agent_id, "reason": reason}
        return self._call("memory.checkpoint", params, deadline_s)

    def agent_open(self, agent_id: str, *, deadline_s: float | None = None) -> dict:
        return self._call("agent.open", {"agentId": agent_id}, deadline_s)

    def agent_close(self, agent_id: str, *, deadline_s: float | None = None) -> dict:
        return self._call("agent.close", {"agentId": agent_id}, deadline_s)

    def agent_status(self, agent_id: str, *, deadline_s: float | None = None) -> dict:
        return self._call("agent.status", {"agentId": agent_id}, deadline_s)

    def memory_list(
        self,
        caller: Caller,
        agent_id: str,
        *,
        topic: str | None = None,
        limit: int | None = None,
        deadline_s: float | None = None,
    ) -> dict:
        params: dict = {"caller": caller.to_rpc(), "agentId": agent_id}
        if topic is not None:
            params["topic"] = topic
        if limit is not None:
            params["limit"] = int(limit)
        return self._call("memory.list", params, deadline_s)

    def memory_show(self, caller: Caller, agent_id: str, memory_id: str, *, deadline_s: float | None = None) -> dict:
        return self._call("memory.show", self._memory_params(caller, agent_id, memory_id), deadline_s)

    def memory_forget(self, caller: Caller, agent_id: str, memory_id: str, *, deadline_s: float | None = None) -> dict:
        return self._call("memory.forget", self._memory_params(caller, agent_id, memory_id), deadline_s)

    def memory_correct(
        self, caller: Caller, agent_id: str, memory_id: str, text: str, *, deadline_s: float | None = None
    ) -> dict:
        params = self._memory_params(caller, agent_id, memory_id)
        params["text"] = text
        return self._call("memory.correct", params, deadline_s)

    def memory_share(
        self,
        caller: Caller,
        agent_id: str,
        memory_id: str,
        target: str,
        allow_sensitive: bool = False,
        *,
        deadline_s: float | None = None,
    ) -> dict:
        params = self._memory_params(caller, agent_id, memory_id)
        params["target"] = target
        if allow_sensitive:
            params["allowSensitive"] = True
        return self._call("memory.share", params, deadline_s)

    @staticmethod
    def _memory_params(caller: Caller, agent_id: str, memory_id: str) -> dict:
        return {"caller": caller.to_rpc(), "agentId": agent_id, "id": memory_id}

    # -- internals --------------------------------------------------------------------------------

    class _Held:
        def __init__(self, lock: threading.Lock) -> None:
            self._lock = lock

        def __enter__(self) -> None:
            return None

        def __exit__(self, *exc: object) -> None:
            self._lock.release()

    def _locked(self, deadline: float) -> MemoryClient._Held:
        if not self._lock.acquire(timeout=max(0.0, deadline - time.monotonic())):
            raise RpcError("E_TIMEOUT", "another call held the connection past the deadline", {"reason": "busy"})
        return MemoryClient._Held(self._lock)

    def _take_id(self) -> int:
        i = self._next_id
        self._next_id += 1
        return i

    def _drop_locked(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.close()
            except Exception:  # noqa: BLE001 - closing is best effort
                pass

    def _check_run_dir(self) -> None:
        path = run_dir(self.home)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            raise RpcError("E_CORE_UNAVAILABLE", "the home has no run directory", {"reason": "no-run-dir"}) from None
        except OSError:
            raise RpcError("E_CORE_UNAVAILABLE", "the run directory is unreadable", {"reason": "run-dir-unreadable"}) from None
        if os.name != "posix" or self.platform == "win32":
            return
        if not stat.S_ISDIR(st.st_mode):
            raise RpcError("E_SERVER_IDENTITY", "run/ is not a directory", {"reason": "run-dir-not-a-directory"})
        if st.st_uid != os.geteuid():
            raise RpcError("E_SERVER_IDENTITY", "run/ belongs to another user", {"reason": "run-dir-owner"})
        if st.st_mode & 0o022:
            raise RpcError("E_SERVER_IDENTITY", "run/ is writable by others", {"reason": "run-dir-writable-by-others"})

    def _read_token(self) -> str:
        try:
            with open(core_token_path(self.home), encoding="ascii", errors="replace") as f:
                token = f.read().strip()
        except FileNotFoundError:
            raise RpcError("E_CORE_UNAVAILABLE", "run/core.token does not exist", {"reason": "token-missing"}) from None
        except OSError:
            raise RpcError("E_CORE_UNAVAILABLE", "run/core.token is unreadable", {"reason": "token-unreadable"}) from None
        if len(token) != 64 or not set(token) <= _HEX:
            raise RpcError("E_CORE_UNAVAILABLE", "run/core.token is malformed", {"reason": "token-invalid"})
        return token

    def _read_expected_pid(self) -> int | None:
        try:
            with open(core_pid_path(self.home), encoding="utf-8", errors="replace") as f:
                text = f.read()
        except FileNotFoundError:
            return None
        except OSError:
            raise RpcError("E_SERVER_IDENTITY", "run/core.pid is unreadable", {"reason": "pid-file-unreadable"}) from None
        fields = text.split()
        if not fields or not fields[0].isdigit() or int(fields[0]) <= 0:
            raise RpcError("E_SERVER_IDENTITY", "run/core.pid is malformed", {"reason": "pid-file-invalid"})
        return int(fields[0])

    def _send_auth(self, stream: Any, req_id: int, deadline: float) -> None:
        """Read the token and send ``core.auth``, only after the S11 check. The token and the encoded line
        live in this frame alone and are cleared before any error leaves it, so no traceback holds them."""
        token: str | None = self._read_token()
        line: bytes | None = encode_request(req_id, "core.auth", {"token": token})
        failure: tuple[str, str, dict] | None = None
        try:
            stream.send(line, deadline)
        except RpcError as e:
            failure = (e.code, e.message, e.data)  # re-raised below, outside this handler: no chained traceback
        finally:
            token = line = None
        if failure is not None:
            raise RpcError(*failure)

    def _connect_locked(self, deadline: float) -> dict:
        # The previous hello stays readable (supports()) until a new one is accepted.
        self._drop_locked()
        self._check_run_dir()
        expected = self._read_expected_pid()
        if not os.path.exists(core_token_path(self.home)):
            raise RpcError("E_CORE_UNAVAILABLE", "run/core.token does not exist", {"reason": "token-missing"})
        left = deadline - time.monotonic()
        if left <= 0:
            raise RpcError("E_TIMEOUT", "no time left to connect", {"reason": "deadline"})
        stream = self._factory(self.address, connect_timeout=min(self.connect_timeout, left))
        try:
            if expected is not None:
                actual = stream.peer_pid()
                if actual != expected:
                    # S11: the token is never sent to a server the OS does not name as run/core.pid.
                    detail = "the OS does not name the server" if actual is None else f"served by pid {actual}"
                    raise RpcError(
                        "E_SERVER_IDENTITY",
                        f"{detail}, run/core.pid names pid {expected}",
                        {"reason": "server-pid-mismatch", "expected": expected, "actual": actual},
                    )
            req_id = self._take_id()
            self._send_auth(stream, req_id, deadline)
            try:
                hello = read_response(stream, req_id, deadline)
            except RpcError as e:
                if e.code == "E_TRANSPORT":
                    raise RpcError("E_CORE_UNAVAILABLE", "the core dropped the handshake", {"reason": "auth-dropped"}) from None
                raise
            if not isinstance(hello, dict):
                raise RpcError("E_PROTOCOL", "core.auth returned no object", {"reason": "bad-hello"})
            major, minor, _ = parse_rpc_version(hello.get("rpc"))
            if major != RPC_MAJOR or minor < RPC_MIN_MINOR:
                self._hello = None  # an incompatible core: its capabilities do not apply
                raise RpcError(
                    "E_RPC_VERSION",
                    f"the core speaks rpc {hello.get('rpc')}; this client needs {RPC_MAJOR}.{RPC_MIN_MINOR} or a later 1.x",
                    {"reason": "rpc-major" if major != RPC_MAJOR else "rpc-minor", "rpc": hello.get("rpc")},
                )
        except BaseException:
            try:
                stream.close()
            except Exception:  # noqa: BLE001
                pass
            raise
        self._stream = stream
        self._hello = hello
        return hello

    def _call(self, method: str, params: dict, deadline_s: float | None) -> Any:
        deadline = time.monotonic() + (self.call_timeout if deadline_s is None else deadline_s)
        with self._locked(deadline):
            gen = self._close_gen
            line_id = self._take_id()
            line = encode_request(line_id, method, params)  # E_PROTOCOL before anything is sent
            retried = False
            while True:
                stream = self._stream
                is_stale = getattr(stream, "is_stale", None) if stream is not None else None
                if stream is None or (is_stale is not None and is_stale()):
                    # Nothing of this call was sent yet: a fresh connection is not a retry.
                    self._connect_locked(min(deadline, time.monotonic() + self.connect_timeout))
                    stream = self._stream
                try:
                    stream.send(line, deadline)
                    return read_response(stream, line_id, deadline)
                except RpcError as e:
                    if e.code in _STREAM_FAULTS:
                        self._drop_locked()  # mid-line or holding a late answer: never reuse
                    if e.code != "E_TRANSPORT":
                        raise
                    if gen != self._close_gen:
                        raise RpcError("E_TRANSPORT", "the client was closed during the call", {"reason": "closed"}) from None
                    if retried:
                        raise RpcError(
                            "E_CORE_UNAVAILABLE", "the core dropped the call again after a reconnect", {"reason": "retry-failed"}
                        ) from None
                    if method not in RETRYABLE_METHODS:
                        raise
                    retried = True
