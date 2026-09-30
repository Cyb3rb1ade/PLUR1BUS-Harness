"""Unix-socket transport (Linux, macOS): ``open_stream(address, *, connect_timeout) -> Stream``.

The server pid comes from the kernel: ``SO_PEERCRED`` on Linux, ``LOCAL_PEERPID`` on macOS; ``None``
elsewhere, which the client refuses when ``run/core.pid`` names a pid (ruling S11).
"""

from __future__ import annotations

import errno
import select
import socket
import struct
import sys

from .protocol import RpcError, read_line
from .protocol import remaining as _remaining

__all__ = ["open_stream", "PosixStream"]

_SOL_LOCAL = 0  # <sys/un.h> on macOS
_LOCAL_PEERPID = 0x002


class PosixStream:
    """One connected ``AF_UNIX`` stream socket, strictly request -> response."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock: socket.socket | None = sock
        self._buf = bytearray()

    def _live(self) -> socket.socket:
        if self._sock is None:
            raise RpcError("E_TRANSPORT", "the connection is closed", {"reason": "closed"})
        return self._sock

    def send(self, data: bytes, deadline: float) -> None:
        sock = self._live()
        try:
            sock.settimeout(_remaining(deadline))
            sock.sendall(data)
        except socket.timeout:
            raise RpcError("E_TIMEOUT", "sending timed out", {"reason": "send-timeout"}) from None
        except OSError as e:
            raise RpcError("E_TRANSPORT", f"sending failed ({_errname(e)})", {"reason": "send-failed"}) from None

    def recv_line(self, deadline: float) -> bytes:
        sock = self._live()

        def chunk() -> bytes:
            try:
                sock.settimeout(_remaining(deadline))
                return sock.recv(65536)
            except socket.timeout:
                raise RpcError("E_TIMEOUT", "no response before the deadline", {"reason": "recv-timeout"}) from None
            except OSError as e:
                raise RpcError("E_TRANSPORT", f"receiving failed ({_errname(e)})", {"reason": "recv-failed"}) from None

        return read_line(self._buf, chunk)

    def is_stale(self) -> bool:
        """True when an idle connection (nothing of the next call sent yet) cannot be trusted: the peer closed
        it, or it holds unsolicited bytes (a late answer, a notification, data followed by EOF). The client
        then connects afresh instead of sending into it."""
        sock = self._sock
        if sock is None:
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
        if sock is None:
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

    def close(self) -> None:
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)  # wakes a recv blocked in another thread
            except OSError:
                pass
            try:
                sock.close()
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
