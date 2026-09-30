"""Named-pipe transport (Windows): ``open_stream(address, *, connect_timeout) -> Stream`` (HM2-R11).

A blocking ``open(r'\\\\.\\pipe\\...', 'r+b')`` read has no deadline, so a stuck core would hang a Hermes
turn. This transport uses ``ctypes`` only:

- ``CreateFileW(..., FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)``: a squatter
  serving the name can identify this client but never impersonate it, not even before the pid check.
- ``ERROR_PIPE_BUSY`` is retried through ``WaitNamedPipeW`` inside the one connect deadline.
- Every ``ReadFile``/``WriteFile`` is overlapped, with its own ``OVERLAPPED`` and manual-reset event, and
  waits with ``WaitForSingleObject(event, <ms to the deadline>)``. On expiry the operation is cancelled
  with ``CancelIoEx`` and awaited with ``GetOverlappedResult(wait=TRUE)`` before its buffer, event or the
  handle are released; an operation that completed anyway still counts.
- ``GetNamedPipeServerProcessId`` names the server for the client's S11 check (HM2-R7), before the token
  is sent.

The Win32 calls sit behind :class:`Kernel32Api`, a thin 1:1 layer that ``open_stream(api=...)`` lets
tests replace with a fake, so the overlapped state machine is tested on every OS. Nothing here touches
``ctypes.WinDLL`` until a stream is opened on Windows: the module imports anywhere. Framing and the
4 MiB line rule are shared with the POSIX transport (``protocol.read_line``).
"""

from __future__ import annotations

import math
import sys
import threading
import time
from typing import Any

from .protocol import RpcError, read_line
from .protocol import remaining as _remaining

__all__ = ["open_stream", "WinPipeStream", "Kernel32Api", "Win32Error"]

# winerror.h
ERROR_FILE_NOT_FOUND = 2
ERROR_PATH_NOT_FOUND = 3
ERROR_ACCESS_DENIED = 5
ERROR_INVALID_HANDLE = 6
ERROR_BROKEN_PIPE = 109
ERROR_SEM_TIMEOUT = 121
ERROR_PIPE_BUSY = 231
ERROR_NO_DATA = 232
ERROR_PIPE_NOT_CONNECTED = 233
ERROR_MORE_DATA = 234
ERROR_OPERATION_ABORTED = 995
ERROR_IO_INCOMPLETE = 996
ERROR_IO_PENDING = 997

WAIT_OBJECT_0 = 0x0
WAIT_TIMEOUT = 0x102
WAIT_FAILED = 0xFFFFFFFF

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
SECURITY_SQOS_PRESENT = 0x00100000
SECURITY_IDENTIFICATION = 0x00010000
#: The open flags: overlapped I/O, and an identification-only token for the server.
OPEN_FLAGS = FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION

_MAX_WAIT_MS = 0xFFFFFFFE  # INFINITE (0xFFFFFFFF) is never passed
_CHUNK = 65536
_EOF_ERRORS = frozenset({ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, ERROR_NO_DATA})
_NO_PIPE_ERRORS = frozenset({ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND})

READ = "read"
WRITE = "write"


class Win32Error(Exception):
    """A failed Win32 call: ``code`` is the ``GetLastError`` value, ``func`` the API name."""

    def __init__(self, code: int, func: str) -> None:
        self.code = int(code)
        self.func = func
        super().__init__(f"{func} failed (winerror {self.code})")


def _timeout_ms(deadline: float) -> int:
    """Milliseconds to the monotonic ``deadline``, rounded up; 0 once it passed; never ``INFINITE``."""
    left = deadline - time.monotonic()
    if left <= 0:
        return 0
    return min(_MAX_WAIT_MS, max(1, math.ceil(left * 1000)))


# -- the Win32 layer -------------------------------------------------------------------------------------


class _Op:
    """One overlapped operation: its ``OVERLAPPED``, event and buffer (all kept alive until ``free_op``)."""

    __slots__ = ("kind", "size", "ov", "event", "buf")

    def __init__(self, kind: str, size: int, ov: Any, event: Any, buf: Any) -> None:
        self.kind, self.size, self.ov, self.event, self.buf = kind, size, ov, event, buf


class Kernel32Api:
    """The kernel32 calls this transport makes, one method per call, nothing else.

    ``dll`` and ``last_error`` exist for tests (default: ``ctypes.WinDLL("kernel32", use_last_error=True)``
    and ``ctypes.get_last_error``). Handles are the integers ``ctypes`` returns for ``HANDLE``.
    """

    def __init__(self, dll: Any = None, last_error: Any = None) -> None:
        import ctypes
        from ctypes import wintypes

        class OVERLAPPED(ctypes.Structure):
            # The Offset/OffsetHigh pair shares its 8 bytes with a PVOID Pointer; the layout is the same.
            _fields_ = [
                ("Internal", ctypes.c_size_t),
                ("InternalHigh", ctypes.c_size_t),
                ("Offset", wintypes.DWORD),
                ("OffsetHigh", wintypes.DWORD),
                ("hEvent", wintypes.HANDLE),
            ]

        self._ct = ctypes
        self._DWORD = wintypes.DWORD
        self._ULONG = wintypes.ULONG
        self.OVERLAPPED = OVERLAPPED
        k = dll if dll is not None else ctypes.WinDLL("kernel32", use_last_error=True)
        self._last_error = last_error if last_error is not None else ctypes.get_last_error
        self._invalid = ctypes.c_void_p(-1).value
        H, D, B = wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL
        LPOV = ctypes.POINTER(OVERLAPPED)
        LPD = ctypes.POINTER(wintypes.DWORD)

        def bind(name: str, restype: Any, *argtypes: Any) -> Any:
            fn = getattr(k, name)
            fn.restype = restype
            fn.argtypes = list(argtypes)
            return fn

        self._CreateFileW = bind("CreateFileW", H, wintypes.LPCWSTR, D, D, wintypes.LPVOID, D, D, H)
        self._WaitNamedPipeW = bind("WaitNamedPipeW", B, wintypes.LPCWSTR, D)
        self._GetNamedPipeServerProcessId = bind("GetNamedPipeServerProcessId", B, H, ctypes.POINTER(wintypes.ULONG))
        self._PeekNamedPipe = bind("PeekNamedPipe", B, H, wintypes.LPVOID, D, LPD, LPD, LPD)
        self._CreateEventW = bind("CreateEventW", H, wintypes.LPVOID, B, B, wintypes.LPCWSTR)
        self._ReadFile = bind("ReadFile", B, H, wintypes.LPVOID, D, LPD, LPOV)
        self._WriteFile = bind("WriteFile", B, H, wintypes.LPCVOID, D, LPD, LPOV)
        self._WaitForSingleObject = bind("WaitForSingleObject", D, H, D)
        self._CancelIoEx = bind("CancelIoEx", B, H, LPOV)
        self._GetOverlappedResult = bind("GetOverlappedResult", B, H, LPOV, LPD, B)
        self._CloseHandle = bind("CloseHandle", B, H)

    def _bad(self, h: Any) -> bool:
        return h is None or h == 0 or h == self._invalid

    def open_pipe(self, name: str) -> int:
        h = self._CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING, OPEN_FLAGS, None)
        if self._bad(h):
            raise Win32Error(self._last_error(), "CreateFileW")
        return h

    def wait_named_pipe(self, name: str, timeout_ms: int) -> int:
        """0 when an instance became free, else the error (``ERROR_SEM_TIMEOUT``, ``ERROR_FILE_NOT_FOUND``)."""
        return 0 if self._WaitNamedPipeW(name, max(1, timeout_ms)) else int(self._last_error())

    def server_pid(self, h: int) -> int | None:
        pid = self._ULONG(0)
        if not self._GetNamedPipeServerProcessId(h, self._ct.byref(pid)):
            return None
        return pid.value or None

    def peek_available(self, h: int) -> int:
        avail = self._DWORD(0)
        if not self._PeekNamedPipe(h, None, 0, None, self._ct.byref(avail), None):
            raise Win32Error(self._last_error(), "PeekNamedPipe")
        return int(avail.value)

    def new_op(self, kind: str, payload: bytes | int) -> _Op:
        event = self._CreateEventW(None, True, False, None)  # manual reset, not signalled
        if self._bad(event):
            raise Win32Error(self._last_error(), "CreateEventW")
        ov = self.OVERLAPPED()
        ov.hEvent = event
        if kind == READ:
            size = int(payload)  # type: ignore[arg-type]
            buf = self._ct.create_string_buffer(size)
        else:
            data = bytes(payload)  # type: ignore[arg-type]
            size = len(data)
            buf = (self._ct.c_char * max(1, size)).from_buffer_copy(data or b"\0")
        return _Op(kind, size, ov, event, buf)

    def start(self, h: int, op: _Op) -> int:
        """Starts the operation: 0 when it completed at once, else ``GetLastError`` (``ERROR_IO_PENDING``...)."""
        fn = self._ReadFile if op.kind == READ else self._WriteFile
        ok = fn(h, op.buf, op.size, None, self._ct.byref(op.ov))
        return 0 if ok else int(self._last_error())

    def wait(self, op: _Op, timeout_ms: int) -> int:
        return int(self._WaitForSingleObject(op.event, timeout_ms))

    def cancel(self, h: int, op: _Op | None) -> None:
        self._CancelIoEx(h, self._ct.byref(op.ov) if op is not None else None)

    def result(self, h: int, op: _Op, wait: bool) -> tuple[int, int]:
        """``(bytes moved, 0)`` or ``(bytes moved, GetLastError)``; ``wait`` blocks until the operation ends."""
        n = self._DWORD(0)
        ok = self._GetOverlappedResult(h, self._ct.byref(op.ov), self._ct.byref(n), bool(wait))
        return int(n.value), (0 if ok else int(self._last_error()))

    def data(self, op: _Op, n: int) -> bytes:
        return self._ct.string_at(op.buf, n) if n > 0 else b""

    def free_op(self, op: _Op) -> None:
        self._CloseHandle(op.event)

    def close_handle(self, h: int) -> None:
        self._CloseHandle(h)


_API: Kernel32Api | None = None
_API_LOCK = threading.Lock()


def _default_api() -> Kernel32Api:
    global _API
    if sys.platform != "win32":
        raise RpcError("E_TRANSPORT", "named pipes exist only on Windows", {"reason": "not-windows"})
    with _API_LOCK:
        if _API is None:
            _API = Kernel32Api()
        return _API


# -- the overlapped state machine ------------------------------------------------------------------------


def _complete(api: Any, h: int, op: _Op, deadline: float) -> tuple[int, int, bool]:
    """Runs ``op`` on ``h`` under ``deadline``: ``(bytes, error, cancelled)``. ``error`` is 0 on success;
    ``cancelled`` says the wait ended without the operation and it was cancelled. After a cancel the
    operation is awaited (``GetOverlappedResult(wait=TRUE)``), so ``op`` is idle whenever this returns."""
    err = api.start(h, op)
    if err in (0, ERROR_MORE_DATA):
        n, e = api.result(h, op, False)
        return n, e, False
    if err != ERROR_IO_PENDING:
        return 0, err, False
    if api.wait(op, _timeout_ms(deadline)) == WAIT_OBJECT_0:
        n, e = api.result(h, op, False)
        return n, e, False
    api.cancel(h, op)
    n, e = api.result(h, op, True)
    return n, e, True


def _winerr(code: int) -> str:
    return f"winerror {code}"


class WinPipeStream:
    """The client end of one named-pipe connection, strictly request -> response.

    ``close()`` may run in another thread while a call is in flight: it cancels the pending operation
    (``CancelIoEx(h, NULL)``) and returns at once; the handle is closed by whichever side finishes last,
    so it is never closed under a pending ``OVERLAPPED``.
    """

    def __init__(self, api: Any, handle: int) -> None:
        self._api = api
        self._h: int | None = handle
        self._buf = bytearray()
        self._state = threading.Lock()
        self._busy = 0
        self._closed = False

    def _enter(self) -> int:
        with self._state:
            if self._closed or self._h is None:
                raise RpcError("E_TRANSPORT", "the connection is closed", {"reason": "closed"})
            self._busy += 1
            return self._h

    def _leave(self) -> None:
        with self._state:
            self._busy -= 1
            h = None
            if self._closed and self._busy == 0 and self._h is not None:
                h, self._h = self._h, None
        if h is not None:
            self._release(h)

    def _release(self, h: int) -> None:
        try:
            self._api.close_handle(h)
        except Exception:  # noqa: BLE001 - closing is best effort
            pass

    def _io(self, kind: str, payload: bytes | int, deadline: float) -> tuple[int, int, bool, bytes]:
        h = self._enter()
        try:
            try:
                op = self._api.new_op(kind, payload)
            except Win32Error as e:
                raise RpcError("E_TRANSPORT", f"no event for the pipe ({_winerr(e.code)})", {"reason": "no-event"}) from None
            try:
                n, err, cancelled = _complete(self._api, h, op, deadline)
                data = self._api.data(op, n) if kind == READ and err in (0, ERROR_MORE_DATA, ERROR_OPERATION_ABORTED) else b""
            finally:
                self._api.free_op(op)
        finally:
            self._leave()
        return n, err, cancelled, data

    def _aborted(self, cancelled: bool, timeout_reason: str, message: str) -> RpcError:
        if self._closed or not cancelled:
            # cancelled by close() in another thread
            return RpcError("E_TRANSPORT", "the connection was closed during the call", {"reason": "closed"})
        return RpcError("E_TIMEOUT", message, {"reason": timeout_reason})

    def send(self, data: bytes, deadline: float) -> None:
        view = memoryview(data)
        while view:
            _remaining(deadline)
            n, err, cancelled, _ = self._io(WRITE, bytes(view), deadline)
            if err == 0:
                view = view[n:]
                continue
            if err == ERROR_OPERATION_ABORTED:
                raise self._aborted(cancelled, "send-timeout", "sending timed out")
            raise RpcError("E_TRANSPORT", f"sending failed ({_winerr(err)})", {"reason": "send-failed"})

    def _read_chunk(self, deadline: float) -> bytes:
        while True:
            _remaining(deadline)
            n, err, cancelled, data = self._io(READ, _CHUNK, deadline)
            if data:
                return data  # also a read that completed while it was being cancelled, or ERROR_MORE_DATA
            if err == 0 or err == ERROR_MORE_DATA:
                continue  # a zero-byte read is not the end of a byte-mode pipe
            if err in _EOF_ERRORS:
                return b""
            if err == ERROR_OPERATION_ABORTED:
                raise self._aborted(cancelled, "recv-timeout", "no response before the deadline")
            raise RpcError("E_TRANSPORT", f"receiving failed ({_winerr(err)})", {"reason": "recv-failed"})

    def recv_line(self, deadline: float) -> bytes:
        self._enter()
        self._leave()
        return read_line(self._buf, lambda: self._read_chunk(deadline))

    def is_stale(self) -> bool:
        """True when an idle connection cannot be trusted: the server closed it, or it holds unsolicited
        bytes (``PeekNamedPipe``), or bytes are buffered from before. The client then connects afresh."""
        if self._buf:
            return True
        try:
            h = self._enter()
        except RpcError:
            return True
        try:
            return self._api.peek_available(h) > 0
        except Win32Error:
            return True  # ERROR_BROKEN_PIPE: the server closed its end
        finally:
            self._leave()

    def peer_pid(self) -> int | None:
        """The pid the OS names as the pipe's server (``GetNamedPipeServerProcessId``); ``None`` if unknown."""
        try:
            h = self._enter()
        except RpcError:
            return None
        try:
            return self._api.server_pid(h)
        except Exception:  # noqa: BLE001 - unknown is refused by the S11 check
            return None
        finally:
            self._leave()

    def close(self) -> None:
        with self._state:
            if self._closed:
                return
            self._closed = True
            h = self._h
            if h is None:
                return
            if self._busy:
                try:
                    self._api.cancel(h, None)  # the in-flight call ends now and closes the handle in _leave
                except Exception:  # noqa: BLE001
                    pass
                return
            self._h = None
        self._release(h)


def open_stream(address: str, *, connect_timeout: float, api: Any = None) -> WinPipeStream:
    """Connect to the named pipe ``address`` within ``connect_timeout`` seconds.

    Busy pipes (``ERROR_PIPE_BUSY``) are waited for with ``WaitNamedPipeW`` until the deadline. Every
    failure to reach a serving core is ``E_CORE_UNAVAILABLE`` (with ``data.reason``). ``api`` replaces
    :class:`Kernel32Api` in tests.
    """
    if connect_timeout <= 0:
        raise RpcError("E_TIMEOUT", "no time left to connect", {"reason": "deadline"})
    deadline = time.monotonic() + connect_timeout
    if api is None:
        api = _default_api()
    while True:
        try:
            handle = api.open_pipe(address)
            break
        except Win32Error as e:
            if e.code == ERROR_PIPE_BUSY:
                left = _timeout_ms(deadline)
                if left <= 0:
                    raise RpcError(
                        "E_CORE_UNAVAILABLE", "every instance of the core pipe stayed busy", {"reason": "pipe-busy"}
                    ) from None
                api.wait_named_pipe(address, left)  # any outcome: try the open again, it tells what happened
                continue
            if e.code in _NO_PIPE_ERRORS:
                raise RpcError("E_CORE_UNAVAILABLE", "the core pipe does not exist", {"reason": "no-pipe"}) from None
            raise RpcError(
                "E_CORE_UNAVAILABLE", f"cannot connect to the core ({_winerr(e.code)})", {"reason": "connect-failed"}
            ) from None
    return WinPipeStream(api, handle)
