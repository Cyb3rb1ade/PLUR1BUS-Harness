"""Local endpoint trust, the Python side of ``crates/plur1bus-rpc/src/trust.rs`` and
``packages/module-api/src/trust.ts`` (audit M2; docs/rpc.md "Local endpoint trust").

On POSIX the trust boundary is the current OS user: ``run/`` is a real directory of the effective uid that
group and others cannot write to, the socket in it is a socket of that uid, and (where the kernel can tell)
the process listening on it runs as that uid. A refusal is ``E_UNAUTHORIZED`` with reason
``run-dir-untrusted``, ``socket-untrusted`` or ``peer-uid-mismatch``, raised before the token is read or sent.

Backwards compatibility: releases before this one raised ``E_SERVER_IDENTITY`` (reasons ``run-dir-owner``,
``run-dir-writable-by-others``, ``run-dir-not-a-directory``) for these cases. The refusal now carries
``data["legacy_code"] == "E_SERVER_IDENTITY"`` so a host that classified the old code can still recognise it
(``is_trust_refusal``). ``E_SERVER_IDENTITY`` itself remains the code of the pid checks (Windows pipe server,
``run/core.pid``), which the other clients also keep unchanged on Windows.
"""

from __future__ import annotations

import os
import socket
import stat
import struct
import sys
from collections.abc import Callable
from typing import Any

from .protocol import RpcError

__all__ = [
    "LEGACY_CODE",
    "REASONS",
    "UntrustedEndpoint",
    "check_peer_uid",
    "check_run_dir",
    "check_socket_file",
    "is_trust_refusal",
    "peer_uid_of",
    "verify_address",
]

LEGACY_CODE = "E_SERVER_IDENTITY"
REASONS = frozenset({"run-dir-untrusted", "socket-untrusted", "peer-uid-mismatch"})

_SOL_LOCAL = 0  # <sys/un.h> on macOS
_LOCAL_PEERCRED = 0x001  # struct xucred { u32 cr_version; u32 cr_uid; i16 cr_ngroups; u32 cr_groups[16]; }
_XUCRED_SIZE = 76


class UntrustedEndpoint(RpcError):
    """``E_UNAUTHORIZED`` raised by the client itself because the local endpoint is not trusted.

    ``reason`` is one of ``REASONS``; ``data["detail"]`` says what was wrong (paths, uids, modes; never a secret).
    """

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(
            "E_UNAUTHORIZED",
            "the local RPC endpoint is not trusted; nothing was sent",
            {"reason": reason, "detail": detail, "legacy_code": LEGACY_CODE},
        )


def is_trust_refusal(exc: object) -> bool:
    """True for a client-side local-endpoint refusal, i.e. what releases before the trust parity raised as
    ``E_SERVER_IDENTITY`` for a bad ``run/``. A server's own ``E_UNAUTHORIZED`` (bad token) is not one."""
    return isinstance(exc, UntrustedEndpoint)


def _posix(platform: str) -> bool:
    return os.name == "posix" and platform != "win32"


def check_run_dir(
    path: str,
    *,
    platform: str = sys.platform,
    euid: int | None = None,
    lstat: Callable[[str], Any] = os.lstat,
) -> None:
    """``path`` must be a real directory of the effective uid with no group/other write bit.

    A missing directory is not a trust failure: it raises ``FileNotFoundError`` for the caller to report as
    "core absent". Any other inspection failure is a refusal (fail closed). No-op off POSIX.
    """
    if not _posix(platform):
        return
    me = os.geteuid() if euid is None else euid
    try:
        st = lstat(path)
    except FileNotFoundError:
        raise
    except OSError as e:
        raise UntrustedEndpoint("run-dir-untrusted", f"{path} cannot be inspected: {e.strerror or type(e).__name__}") from None
    if stat.S_ISLNK(st.st_mode):
        raise UntrustedEndpoint("run-dir-untrusted", f"{path} is a symlink")
    if not stat.S_ISDIR(st.st_mode):
        raise UntrustedEndpoint("run-dir-untrusted", f"{path} is not a directory")
    if st.st_uid != me:
        raise UntrustedEndpoint("run-dir-untrusted", f"{path} belongs to uid {st.st_uid}, not to this user (uid {me})")
    if st.st_mode & 0o022:
        raise UntrustedEndpoint(
            "run-dir-untrusted", f"{path} is writable by group or others (mode {oct(st.st_mode & 0o7777)[2:]})"
        )


def check_socket_file(
    path: str,
    *,
    platform: str = sys.platform,
    euid: int | None = None,
    lstat: Callable[[str], Any] = os.lstat,
) -> None:
    """``path`` must be a socket of the effective uid. A missing file is "core absent" (``FileNotFoundError``)."""
    if not _posix(platform):
        return
    me = os.geteuid() if euid is None else euid
    try:
        st = lstat(path)
    except FileNotFoundError:
        raise
    except OSError as e:
        raise UntrustedEndpoint("socket-untrusted", f"{path} cannot be inspected: {e.strerror or type(e).__name__}") from None
    if not stat.S_ISSOCK(st.st_mode):
        raise UntrustedEndpoint("socket-untrusted", f"{path} is not a socket")
    if st.st_uid != me:
        raise UntrustedEndpoint("socket-untrusted", f"{path} belongs to uid {st.st_uid}, not to this user (uid {me})")


def verify_address(address: str, *, platform: str = sys.platform, euid: int | None = None, lstat: Callable[[str], Any] = os.lstat) -> None:
    """Directory check of the address's parent, then the socket check; a filesystem address only."""
    if not _posix(platform) or not os.path.isabs(address):
        return
    check_run_dir(os.path.dirname(address), platform=platform, euid=euid, lstat=lstat)
    check_socket_file(address, platform=platform, euid=euid, lstat=lstat)


def check_peer_uid(peer: int | None, euid: int | None = None) -> None:
    """Refuse a server whose kernel-reported uid is not ours. An unknown peer (``None``) passes: the
    filesystem checks stay the guard where the OS cannot say (same as the Rust client)."""
    me = os.geteuid() if euid is None else euid
    if peer is not None and peer != me:
        raise UntrustedEndpoint("peer-uid-mismatch", f"the socket is served by uid {peer}, not by this user (uid {me})")


def peer_uid_of(sock: socket.socket) -> int | None:
    """The uid the kernel names as the owner of the listening end: ``SO_PEERCRED`` on Linux, ``LOCAL_PEERCRED``
    (``struct xucred``) on macOS; ``None`` where neither is available or the call fails."""
    try:
        if sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED"):
            raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            _pid, uid, _gid = struct.unpack("3i", raw)
            return uid if uid >= 0 else None
        if sys.platform == "darwin":
            raw = sock.getsockopt(_SOL_LOCAL, _LOCAL_PEERCRED, _XUCRED_SIZE)
            if len(raw) >= 8:
                _version, uid = struct.unpack_from("=II", raw)
                return uid
    except (OSError, struct.error):
        return None
    return None
