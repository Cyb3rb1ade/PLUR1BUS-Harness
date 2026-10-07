"""Unix-socket transport (Linux, macOS): ``open_stream(address, *, connect_timeout) -> Stream``.

The server pid comes from the kernel: ``SO_PEERCRED`` on Linux, ``LOCAL_PEERPID`` on macOS; ``None``
elsewhere, which the client refuses when ``run/core.pid`` names a pid (ruling S11).
"""

from __future__ import annotations

import errno
import os
import select
import socket
import struct
import sys
import threading
import time

from .protocol import RpcError, read_line
from .trust import peer_uid_of
from .protocol import remaining as _remaining

__all__ = ["open_stream", "PosixStream"]

_SOL_LOCAL = 0  # <sys/un.h> on macOS
_LOCAL_PEERPID = 0x002
_HAS_POLL = hasattr(select, "poll")


class PosixStream:
    """One connected ``AF_UNIX`` stream socket, strictly request -> response.

    ``close()`` may run on another thread while a call waits in ``send``/``recv_line`` (the client's
    ``close(deadline_s=)``). Waking that thread must not depend on ``shutdown()`` interrupting a
    ``poll()`` on the socket: on macOS it does not for ``AF_UNIX`` (CI round 1, macos-15), so every
    wait also watches a private wake pipe that ``close()`` writes to. The socket's fd is only closed
    once no call is using it, so a waiting thread never polls a number the process has reused.
    """

    def __init__(self, sock: socket.socket) -> None:
        self._sock: socket.socket | None = sock
        self._buf = bytearray()
        self._state = threading.Lock()
        self._busy = 0
        self._closed = False
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_w, False)
        sock.setblocking(False)

    def _closed_error(self) -> RpcError:
        return RpcError("E_TRANSPORT", "the connection is closed", {"reason": "closed"})

    def _enter(self) -> socket.socket:
        with self._state:
            if self._closed or self._sock is None:
                raise self._closed_error()
            self._busy += 1
            return self._sock

    def _leave(self) -> None:
        with self._state:
            self._busy -= 1
            release = self._closed and self._busy == 0
        if release:
            self._release()

    def _wait(self, sock: socket.socket, writable: bool, deadline: float, timeout: RpcError) -> None:
        """Block until ``sock`` is readable (or writable), the deadline passes (``timeout`` is raised) or
        ``close()`` wakes the pipe (``E_TRANSPORT``, reason ``closed``)."""
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise timeout
            if self._closed:
                raise self._closed_error()
            try:
                if _HAS_POLL:
                    p = select.poll()
                    p.register(sock.fileno(), select.POLLOUT if writable else select.POLLIN)
                    p.register(self._wake_r, select.POLLIN)
                    ready = {fd for fd, _ in p.poll(max(1, int(left * 1000 + 0.999)))}
                else:  # pragma: no cover - every supported POSIX Python has poll
                    rs, ws, _ = select.select(
                        [self._wake_r] + ([] if writable else [sock]), [sock] if writable else [], [], left
                    )
                    ready = {f if isinstance(f, int) else f.fileno() for f in rs + ws}
            except (OSError, ValueError):
                if self._closed:
                    raise self._closed_error() from None
                raise
            if self._wake_r in ready or self._closed:
                raise self._closed_error()
            if ready:
                return

    def send(self, data: bytes, deadline: float) -> None:
        sock = self._enter()
        try:
            _remaining(deadline)
            view = memoryview(data)
            timeout = RpcError("E_TIMEOUT", "sending timed out", {"reason": "send-timeout"})
            while view:
                try:
                    n = sock.send(view)
                except BlockingIOError:
                    self._wait(sock, True, deadline, timeout)
                    continue
                except OSError as e:
                    if self._closed:
                        raise self._closed_error() from None
                    raise RpcError("E_TRANSPORT", f"sending failed ({_errname(e)})", {"reason": "send-failed"}) from None
                view = view[n:]
        finally:
            self._leave()

    def recv_line(self, deadline: float) -> bytes:
        sock = self._enter()
        timeout = RpcError("E_TIMEOUT", "no response before the deadline", {"reason": "recv-timeout"})

        def chunk() -> bytes:
            while True:
                _remaining(deadline)
                try:
                    return sock.recv(65536)
                except BlockingIOError:
                    self._wait(sock, False, deadline, timeout)
                except OSError as e:
                    if self._closed:
                        raise self._closed_error() from None
                    raise RpcError("E_TRANSPORT", f"receiving failed ({_errname(e)})", {"reason": "recv-failed"}) from None

        try:
            return read_line(self._buf, chunk)
        finally:
            self._leave()

    def is_stale(self) -> bool:
        """True when an idle connection (nothing of the next call sent yet) cannot be trusted: the peer closed
        it, or it holds unsolicited bytes (a late answer, a notification, data followed by EOF). The client
        then connects afresh instead of sending into it."""
        sock = self._sock
        if sock is None or self._closed:
            return True
        if self._buf:
            return True
        try:
            readable, _, _ = select.select([sock], [], [], 0)
        except (OSError, ValueError):
            return True
        return bool(readable)

    def peer_pid(self) -> int | None:
        sock = self._sock
        if sock is None or self._closed:
            return None
        try:
            if sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED"):
                raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
                pid, _uid, _gid = struct.unpack("3i", raw)
                return pid if pid > 0 else None
            if sys.platform == "darwin":
                raw = sock.getsockopt(_SOL_LOCAL, _LOCAL_PEERPID, struct.calcsize("i"))
                (pid,) = struct.unpack("i", raw)
                return pid if pid > 0 else None
        except OSError:
            return None
        return None

    def peer_uid(self) -> int | None:
        """The uid the kernel names for the listening end (``SO_PEERCRED`` / ``LOCAL_PEERCRED``), or ``None``."""
        sock = self._sock
        if sock is None or self._closed:
            return None
        return peer_uid_of(sock)

    def close(self) -> None:
        """Idempotent. Wakes a call waiting on another thread (it fails with ``E_TRANSPORT``, reason
        ``closed``); the fds are released now, or by that call as it leaves."""
        with self._state:
            if self._closed:
                return
            self._closed = True
            release = self._busy == 0
        try:
            os.write(self._wake_w, b"x")
        except OSError:
            pass
        sock = self._sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)  # tells the peer at once; not relied on for the wake-up
            except OSError:
                pass
        if release:
            self._release()

    def _release(self) -> None:
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        for fd in (self._wake_r, self._wake_w):
            try:
                os.close(fd)
            except OSError:
                pass


def _errname(e: OSError) -> str:
    return errno.errorcode.get(e.errno or 0, type(e).__name__)


def open_stream(address: str, *, connect_timeout: float) -> PosixStream:
    """Connect to the Unix socket ``address`` within ``connect_timeout`` seconds.

    Every failure to reach a listening core is ``E_CORE_UNAVAILABLE`` (with ``data.reason``).
    """
    if not hasattr(socket, "AF_UNIX"):
        raise RpcError("E_TRANSPORT", "this Python has no Unix sockets", {"reason": "no-af-unix"})
    if connect_timeout <= 0:
        raise RpcError("E_TIMEOUT", "no time left to connect", {"reason": "deadline"})
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(connect_timeout)
        sock.connect(address)
    except socket.timeout:
        sock.close()
        raise RpcError("E_CORE_UNAVAILABLE", "connecting to the core timed out", {"reason": "connect-timeout"}) from None
    except FileNotFoundError:
        sock.close()
        raise RpcError("E_CORE_UNAVAILABLE", "the core socket does not exist", {"reason": "no-socket"}) from None
    except ConnectionRefusedError:
        sock.close()
        raise RpcError("E_CORE_UNAVAILABLE", "no core listens on the socket", {"reason": "refused"}) from None
    except OSError as e:
        sock.close()
        raise RpcError(
            "E_CORE_UNAVAILABLE", f"cannot connect to the core ({_errname(e)})", {"reason": "connect-failed"}
        ) from None
    return PosixStream(sock)
