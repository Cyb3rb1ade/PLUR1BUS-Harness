"""Fakes for the named-pipe transport.

- :class:`FakeKernel32` (any OS) stands in for ``transport_win.Kernel32Api``: a scripted pipe server
  behind the same thin calls (open, wait for a busy pipe, overlapped start/wait/cancel/result, peek,
  server pid, close). It logs every call in order, so tests can check that a timed-out operation was
  cancelled with ``CancelIoEx`` and awaited before the handle was closed, and that no event leaks.
- :class:`FakePipeCore` (Windows only) is a real fake core: ``CreateNamedPipeW`` + overlapped
  ``ConnectNamedPipe``/``ReadFile``/``WriteFile`` in threads, with its own ``ctypes`` bindings (it does
  not reuse the code under test). It writes ``run/core.token`` and ``run/core.pid`` like
  ``tests.fakes.FakeCore`` and answers the same way.

Both answer through :class:`Responder`: ``core.auth`` checks the token and returns a hello; other
methods come from handlers or the rpc-schema fixtures (``DROP``, ``SILENT``, ``Raw``, ``FakeError`` as in
``tests.fakes``).
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
from typing import Any

from tests.fakes import DROP, SILENT, FakeError, Raw, _write, default_capabilities, fixture_result

from plur1bus_memory_client import core_address
from plur1bus_memory_client.transport_win import (
    ERROR_BROKEN_PIPE,
    ERROR_FILE_NOT_FOUND,
    ERROR_INVALID_HANDLE,
    ERROR_IO_INCOMPLETE,
    ERROR_IO_PENDING,
    ERROR_MORE_DATA,
    ERROR_NO_DATA,
    ERROR_NOT_FOUND,
    ERROR_OPERATION_ABORTED,
    ERROR_PIPE_BUSY,
    ERROR_SEM_TIMEOUT,
    READ,
    WAIT_FAILED,
    WAIT_OBJECT_0,
    WAIT_TIMEOUT,
    Win32Error,
)

__all__ = ["FakeKernel32", "FakePipeCore", "Responder", "write_run_files", "BUSY_FOREVER"]

BUSY_FOREVER = -1


def write_run_files(home: str, token: str, pid: int | None) -> None:
    run = os.path.join(home, "run")
    os.makedirs(run, mode=0o700, exist_ok=True)
    _write(os.path.join(run, "core.token"), token + "\n")
    if pid is not None:
        _write(os.path.join(run, "core.pid"), f"{pid} inst-fake\n")


class Responder:
    """Turns one request line into the reply bytes (``None``: no reply, ``DROP``: close the pipe)."""

    def __init__(self, *, token: str | None, pid: int, rpc: str = "1.5.0", handlers: dict | None = None) -> None:
        self.token = token
        self.pid = pid
        self.rpc = rpc
        self.handlers: dict[str, Any] = dict(handlers or {})
        self.calls: list[tuple[str, dict]] = []
        self._lock = threading.Lock()

    def methods(self) -> list[str]:
        with self._lock:
            return [m for m, _ in self.calls]

    def answer(self, raw: bytes, state: dict) -> Any:
        try:
            msg = json.loads(raw)
        except ValueError:
            return None
        method, params, req_id = msg.get("method"), msg.get("params") or {}, msg.get("id")
        with self._lock:
            self.calls.append((method, {} if method == "core.auth" else params))
        if method == "core.auth":
            outcome = self.handlers.get("core.auth", self._auth)
        elif not state.get("authed"):
            outcome = FakeError("E_UNAUTHORIZED", "not-authenticated")
        else:
            outcome = self.handlers.get(method)
            if outcome is None:
                try:
                    outcome = fixture_result(method)
                except FileNotFoundError:
                    outcome = FakeError("E_NOT_AVAILABLE", "no-fixture")
        if callable(outcome):
            outcome = outcome(params)
        if outcome is DROP:
            return DROP
        if outcome is SILENT:
            return None
        if isinstance(outcome, Raw):
            return outcome.line + b"\n"
        if isinstance(outcome, FakeError):
            reply = {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": outcome.message, "data": {"error": outcome.code, "reason": outcome.reason}},
            }
        else:
            reply = {"jsonrpc": "2.0", "id": req_id, "result": outcome}
            if method == "core.auth":
                state["authed"] = True
        return json.dumps(reply).encode("utf-8") + b"\n"

    def _auth(self, params: dict) -> Any:
        if self.token is not None and params.get("token") != self.token:
            return FakeError("E_UNAUTHORIZED", "bad-token", "unauthorized")
        return {"contract": "1.4.1", "rpc": self.rpc, "instanceId": "inst-fake", "pid": self.pid, "capabilities": default_capabilities()}


# -- the scripted kernel32 (any OS) ----------------------------------------------------------------------


class FakeOp:
    _ids = 0

    def __init__(self, kind: str, payload: bytes | int) -> None:
        FakeOp._ids += 1
        self.id = FakeOp._ids
        self.kind = kind
        self.size = int(payload) if kind == READ else len(payload)  # type: ignore[arg-type]
        self.payload = b"" if kind == READ else bytes(payload)  # type: ignore[arg-type]
        self.buf = b""
        self.done = False
        self.n = 0
        self.err = 0
        self.event = threading.Event()

    def finish(self, n: int, err: int, buf: bytes = b"") -> None:
        self.n, self.err, self.buf, self.done = n, err, buf, True
        self.event.set()


class FakeConn:
    def __init__(self, handle: int) -> None:
        self.handle = handle
        self.outbound: list[bytes] = []
        self.inbound = bytearray()
        self.state: dict = {}
        self.broken = False
        self.closed = False
        self.pending: list[FakeOp] = []


class FakeKernel32:
    """A scripted server behind ``Kernel32Api``'s calls.

    ``server_pid``: what ``GetNamedPipeServerProcessId`` reports (``None``: the call fails).
    ``busy``: how many opens fail with ``ERROR_PIPE_BUSY`` (``BUSY_FOREVER``: all; ``WaitNamedPipeW`` then
    sleeps its timeout). ``exists=False``: opens fail with ``ERROR_FILE_NOT_FOUND``. ``message_mode``: a
    read smaller than the queued message returns ``ERROR_MORE_DATA``. ``sync``: operations that can
    finish at once complete synchronously instead of through the event. ``stall_writes``: writes stay
    pending (a server that does not read). ``complete_on_cancel``: bytes a read delivers while it is
    being cancelled (the race a real pipe can have). ``complete_before_cancel``: bytes a read delivers
    just before ``CancelIoEx`` runs, which then fails with ``ERROR_NOT_FOUND``. ``wait_failed``:
    ``WaitForSingleObject`` returns ``WAIT_FAILED`` at once.
    """

    def __init__(
        self,
        *,
        token: str | None = None,
        server_pid: int | None = 4242,
        busy: int = 0,
        exists: bool = True,
        message_mode: bool = False,
        sync: bool = False,
        handlers: dict | None = None,
        rpc: str = "1.5.0",
    ) -> None:
        self.reported_pid = server_pid
        self.busy = busy
        self.exists = exists
        self.message_mode = message_mode
        self.sync = sync
        self.stall_writes = False
        self.complete_on_cancel: bytes | None = None
        self.complete_before_cancel: bytes | None = None
        self.wait_failed = False
        self.responder = Responder(token=token, pid=server_pid or 0, rpc=rpc, handlers=handlers)
        self.log: list[tuple] = []
        self.addresses: list[str] = []
        self.conns: dict[int, FakeConn] = {}
        self.events_open = 0
        self.closed_under_pending = 0
        self.writes: list[bytes] = []
        self._next = 100
        self._lock = threading.RLock()

    # -- helpers for tests ------------------------------------------------------------------------------

    @property
    def opens(self) -> int:
        return len(self.conns)

    def methods(self) -> list[str]:
        return self.responder.methods()

    def last(self) -> FakeConn:
        with self._lock:
            return self.conns[max(self.conns)]

    def push(self, data: bytes, conn: FakeConn | None = None) -> None:
        """The server sends ``data`` (a chunk, or one message in message mode)."""
        with self._lock:
            self._queue(conn or self.last(), data)

    def break_pipe(self, conn: FakeConn | None = None) -> None:
        """The server closes its end: a pending read ends with ``ERROR_BROKEN_PIPE`` once data is drained."""
        with self._lock:
            c = conn or self.last()
            c.broken = True
            for op in list(c.pending):
                if op.kind == READ and not c.outbound:
                    c.pending.remove(op)
                    op.finish(0, ERROR_BROKEN_PIPE)

    def calls(self, name: str) -> list[tuple]:
        return [e for e in self.log if e[0] == name]

    # -- internals ----------------------------------------------------------------------------------------

    def _fill(self, c: FakeConn, op: FakeOp) -> None:
        msg = c.outbound[0]
        take, rest = msg[: op.size], msg[op.size :]
        err = 0
        if rest:
            c.outbound[0] = rest
            if self.message_mode:
                err = ERROR_MORE_DATA
        else:
            c.outbound.pop(0)
        op.finish(len(take), err, take)

    def _queue(self, c: FakeConn, data: bytes) -> None:
        c.outbound.append(data)
        for op in list(c.pending):
            if op.kind == READ and c.outbound:
                c.pending.remove(op)
                self._fill(c, op)

    def _serve_lines(self, c: FakeConn) -> None:
        while True:
            nl = c.inbound.find(b"\n")
            if nl < 0:
                return
            raw = bytes(c.inbound[:nl])
            del c.inbound[: nl + 1]
            reply = self.responder.answer(raw, c.state)
            if reply is DROP:
                self.break_pipe(c)
                return
            if reply is not None:
                self._queue(c, reply)

    def _conn(self, h: int) -> FakeConn | None:
        c = self.conns.get(h)
        return None if c is None or c.closed else c

    # -- the Kernel32Api surface --------------------------------------------------------------------------

    def open_pipe(self, name: str) -> int:
        with self._lock:
            self.log.append(("open", name))
            self.addresses.append(name)
            if not self.exists:
                raise Win32Error(ERROR_FILE_NOT_FOUND, "CreateFileW")
            if self.busy == BUSY_FOREVER or self.busy > 0:
                if self.busy > 0:
                    self.busy -= 1
                raise Win32Error(ERROR_PIPE_BUSY, "CreateFileW")
            self._next += 4
            self.conns[self._next] = FakeConn(self._next)
            return self._next

    def wait_named_pipe(self, name: str, timeout_ms: int) -> int:
        with self._lock:
            self.log.append(("wait_named_pipe", timeout_ms))
            forever = self.busy == BUSY_FOREVER
        if forever:
            time.sleep(timeout_ms / 1000.0)
            return ERROR_SEM_TIMEOUT
        return 0

    def server_pid(self, h: int) -> int | None:
        with self._lock:
            self.log.append(("server_pid", h))
            return self.reported_pid

    def peek_available(self, h: int) -> int:
        with self._lock:
            c = self._conn(h)
            if c is None:
                raise Win32Error(ERROR_INVALID_HANDLE, "PeekNamedPipe")
            avail = sum(len(m) for m in c.outbound)
            if not avail and c.broken:
                raise Win32Error(ERROR_BROKEN_PIPE, "PeekNamedPipe")
            return avail

    def new_op(self, kind: str, payload: bytes | int) -> FakeOp:
        with self._lock:
            self.events_open += 1
            op = FakeOp(kind, payload)
            self.log.append(("new_op", op.id, kind))
            return op

    def start(self, h: int, op: FakeOp) -> int:
        with self._lock:
            self.log.append(("start", h, op.id, op.kind))
            c = self._conn(h)
            if c is None:
                return ERROR_INVALID_HANDLE
            if op.kind == READ:
                if c.outbound:
                    self._fill(c, op)
                    return op.err if self.sync else ERROR_IO_PENDING
                if c.broken:
                    return ERROR_BROKEN_PIPE
                c.pending.append(op)
                return ERROR_IO_PENDING
            if c.broken:
                return ERROR_NO_DATA
            if self.stall_writes:
                c.pending.append(op)
                return ERROR_IO_PENDING
            self.writes.append(op.payload)
            c.inbound += op.payload
            op.finish(op.size, 0)
            self._serve_lines(c)
            return 0 if self.sync else ERROR_IO_PENDING

    def wait(self, op: FakeOp, timeout_ms: int) -> int:
        self.log.append(("wait", op.id, timeout_ms))
        if self.wait_failed:
            return WAIT_FAILED
        return WAIT_OBJECT_0 if op.event.wait(timeout_ms / 1000.0) else WAIT_TIMEOUT

    def cancel(self, h: int, op: FakeOp | None) -> int:
        """``CancelIoEx``: 0, or ``ERROR_NOT_FOUND`` when nothing matching was pending."""
        with self._lock:
            c = self.conns.get(h)
            if c is not None and self.complete_before_cancel is not None:
                data = self.complete_before_cancel
                for t in [op] if op is not None else list(c.pending):
                    if not t.done and t.kind == READ:
                        if t in c.pending:
                            c.pending.remove(t)
                        t.finish(len(data), 0, data)
            targets = ([op] if op is not None else list(c.pending)) if c is not None else []
            live = [t for t in targets if not t.done]
            outcome = 0 if live else ERROR_NOT_FOUND
            self.log.append(("cancel", h, op.id if op is not None else None) + (() if live else ("not-found",)))
            for t in live:
                if t in c.pending:  # type: ignore[union-attr]
                    c.pending.remove(t)  # type: ignore[union-attr]
                if t.kind == READ and self.complete_on_cancel is not None:
                    data = self.complete_on_cancel
                    t.finish(len(data), 0, data)
                else:
                    t.finish(0, ERROR_OPERATION_ABORTED)
            return outcome

    def result(self, h: int, op: FakeOp, wait: bool) -> tuple[int, int]:
        self.log.append(("result", h, op.id, bool(wait)))
        if not op.done:
            if not wait:
                return 0, ERROR_IO_INCOMPLETE
            if not op.event.wait(5):
                raise AssertionError("GetOverlappedResult(wait=TRUE) on an operation nobody completes")
        return op.n, op.err

    def data(self, op: FakeOp, n: int) -> bytes:
        return op.buf[:n]

    def free_op(self, op: FakeOp) -> None:
        with self._lock:
            self.events_open -= 1
            self.log.append(("free_op", op.id))

    def close_handle(self, h: int) -> None:
        with self._lock:
            self.log.append(("close", h))
            c = self.conns.get(h)
            if c is not None:
                if any(not op.done for op in c.pending):
                    self.closed_under_pending += 1
                c.closed = True


# -- a real named-pipe fake core (Windows only) ----------------------------------------------------------

_PIPE_ACCESS_DUPLEX = 0x3
_FILE_FLAG_OVERLAPPED = 0x40000000
_PIPE_TYPE_BYTE_READMODE_BYTE_WAIT = 0x0
_PIPE_UNLIMITED_INSTANCES = 255
_ERROR_PIPE_CONNECTED = 535


class _ServerKernel32:
    """The server-side calls of :class:`FakePipeCore`, bound independently of ``transport_win``."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        class OVERLAPPED(ctypes.Structure):
            _fields_ = [
                ("Internal", ctypes.c_size_t),
                ("InternalHigh", ctypes.c_size_t),
                ("Offset", wintypes.DWORD),
                ("OffsetHigh", wintypes.DWORD),
                ("hEvent", wintypes.HANDLE),
            ]

        self.ct = ctypes
        self.OVERLAPPED = OVERLAPPED
        self.DWORD = wintypes.DWORD
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        H, D, B = wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL
        LPOV, LPD = ctypes.POINTER(OVERLAPPED), ctypes.POINTER(wintypes.DWORD)

        def bind(name: str, restype: Any, *argtypes: Any) -> Any:
            fn = getattr(k, name)
            fn.restype, fn.argtypes = restype, list(argtypes)
            return fn

        self.CreateNamedPipeW = bind("CreateNamedPipeW", H, wintypes.LPCWSTR, D, D, D, D, D, D, wintypes.LPVOID)
        self.ConnectNamedPipe = bind("ConnectNamedPipe", B, H, LPOV)
        self.DisconnectNamedPipe = bind("DisconnectNamedPipe", B, H)
        self.CreateEventW = bind("CreateEventW", H, wintypes.LPVOID, B, B, wintypes.LPCWSTR)
        self.ReadFile = bind("ReadFile", B, H, wintypes.LPVOID, D, LPD, LPOV)
        self.WriteFile = bind("WriteFile", B, H, wintypes.LPCVOID, D, LPD, LPOV)
        self.WaitForSingleObject = bind("WaitForSingleObject", D, H, D)
        self.GetOverlappedResult = bind("GetOverlappedResult", B, H, LPOV, LPD, B)
        self.CancelIoEx = bind("CancelIoEx", B, H, LPOV)
        self.CloseHandle = bind("CloseHandle", B, H)
        self.invalid = ctypes.c_void_p(-1).value

    def last_error(self) -> int:
        return int(self.ct.get_last_error())


class FakePipeCore:
    """A fake core serving ``address`` (default: the home's pipe) with real overlapped named-pipe I/O.

    ``pid`` is what ``run/core.pid`` says (default: this process, which really is the server).
    ``max_instances=1`` makes a second client see ``ERROR_PIPE_BUSY`` while the first stays connected.
    """

    def __init__(
        self,
        home: str,
        *,
        address: str | None = None,
        token: str | None = None,
        pid: int | None = None,
        rpc: str = "1.5.0",
        handlers: dict | None = None,
        max_instances: int = _PIPE_UNLIMITED_INSTANCES,
    ) -> None:
        if sys.platform != "win32":
            raise RuntimeError("FakePipeCore needs Windows")
        self.home = home
        self.address = address or core_address(home, "win32")
        self.token = token or secrets.token_hex(32)
        self.pid = os.getpid() if pid is None else pid
        self.max_instances = max_instances
        self.responder = Responder(token=self.token, pid=os.getpid(), rpc=rpc, handlers=handlers)
        self.connections = 0
        self.error: int | None = None
        self._k: _ServerKernel32 | None = None
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._ready = threading.Event()

    @property
    def calls(self) -> list[tuple[str, dict]]:
        return list(self.responder.calls)

    def methods(self) -> list[str]:
        return self.responder.methods()

    def start(self) -> FakePipeCore:
        write_run_files(self.home, self.token, self.pid)
        self._k = _ServerKernel32()
        self._stop.clear()
        t = threading.Thread(target=self._accept_loop, name="fake-pipe-accept", daemon=True)
        t.start()
        self._threads.append(t)
        if not self._ready.wait(5) or self.error is not None:
            self.stop()
            raise RuntimeError(f"fake pipe core did not start (winerror {self.error})")
        return self

    def stop(self) -> None:
        self._stop.set()
        for t in list(self._threads):
            t.join(timeout=5)
        self._threads = []

    def __enter__(self) -> FakePipeCore:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def _await(self, h: Any, ov: Any, ev: Any) -> tuple[int, int]:
        """Waits for an overlapped operation, polling the stop flag; on stop cancels and awaits it."""
        k = self._k
        assert k is not None
        n = k.DWORD(0)
        while True:
            if k.WaitForSingleObject(ev, 50) == 0:
                ok = k.GetOverlappedResult(h, k.ct.byref(ov), k.ct.byref(n), False)
                return int(n.value), (0 if ok else k.last_error())
            if self._stop.is_set():
                k.CancelIoEx(h, k.ct.byref(ov))
                ok = k.GetOverlappedResult(h, k.ct.byref(ov), k.ct.byref(n), True)
                return int(n.value), (0 if ok else k.last_error())

    def _op(self, h: Any, start: Any) -> tuple[int, int]:
        k = self._k
        assert k is not None
        ev = k.CreateEventW(None, True, False, None)
        ov = k.OVERLAPPED()
        ov.hEvent = ev
        try:
            ok = start(k.ct.byref(ov))
            err = 0 if ok else k.last_error()
            if err in (0, ERROR_IO_PENDING, ERROR_MORE_DATA):
                return self._await(h, ov, ev)
            return 0, err
        finally:
            k.CloseHandle(ev)

    def _accept_loop(self) -> None:
        k = self._k
        assert k is not None
        first = True
        while not self._stop.is_set():
            h = k.CreateNamedPipeW(
                self.address,
                _PIPE_ACCESS_DUPLEX | _FILE_FLAG_OVERLAPPED,
                _PIPE_TYPE_BYTE_READMODE_BYTE_WAIT,
                self.max_instances,
                65536,
                65536,
                0,
                None,
            )
            if h is None or h == k.invalid:
                err = k.last_error()
                if err == ERROR_PIPE_BUSY and not first:
                    time.sleep(0.02)  # every instance is taken: wait for one to be released
                    continue
                self.error = err
                self._ready.set()
                return
            if first:
                first = False
                self._ready.set()
            _n, err = self._op(h, lambda ov: k.ConnectNamedPipe(h, ov))
            if err == _ERROR_PIPE_CONNECTED:
                err = 0
            if err != 0:
                k.CloseHandle(h)
                continue
            self.connections += 1
            t = threading.Thread(target=self._serve, args=(h,), name="fake-pipe-conn", daemon=True)
            t.start()
            self._threads.append(t)

    def _serve(self, h: Any) -> None:
        k = self._k
        assert k is not None
        state: dict = {}
        buf = bytearray()
        chunk = k.ct.create_string_buffer(65536)
        try:
            while not self._stop.is_set():
                n, err = self._op(h, lambda ov: k.ReadFile(h, chunk, 65536, None, ov))
                if err not in (0, ERROR_MORE_DATA) or (n == 0 and err == 0 and self._stop.is_set()):
                    return
                buf += chunk.raw[:n]
                while True:
                    nl = buf.find(b"\n")
                    if nl < 0:
                        break
                    raw = bytes(buf[:nl])
                    del buf[: nl + 1]
                    reply = self.responder.answer(raw, state)
                    if reply is DROP:
                        return
                    if reply is not None and not self._write_all(h, reply):
                        return
        finally:
            k.DisconnectNamedPipe(h)
            k.CloseHandle(h)

    def _write_all(self, h: Any, data: bytes) -> bool:
        k = self._k
        assert k is not None
        view = memoryview(data)
        while view:
            part = bytes(view[: 1 << 20])
            cbuf = (k.ct.c_char * len(part)).from_buffer_copy(part)
            n, err = self._op(h, lambda ov: k.WriteFile(h, cbuf, len(part), None, ov))
            if err != 0:
                return False
            view = view[n:]
        return True
