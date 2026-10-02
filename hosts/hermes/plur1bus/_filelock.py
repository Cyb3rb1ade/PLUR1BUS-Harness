"""A bounded, cross-process file lock (stdlib only): a per-path lock in this process plus ``flock`` on
POSIX or ``msvcrt.locking`` on Windows, both taken with a deadline. Hook paths pass a short timeout and
skip their work on ``LockTimeout``; background work passes a long one."""

from __future__ import annotations

import os
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

__all__ = ["ExclusiveLockFile", "FileLock", "LockTimeout"]

_PROCESS_LOCKS: dict[str, threading.Lock] = {}
_GUARD = threading.Lock()


class LockTimeout(TimeoutError):
    """The lock was not free within the timeout (a ``TimeoutError``, so an ``OSError``)."""


class FileLock:
    def __init__(self, path: str) -> None:
        self.path = path
        key = os.path.normcase(os.path.abspath(path))
        with _GUARD:
            self._local = _PROCESS_LOCKS.setdefault(key, threading.Lock())

    @contextmanager
    def hold(self, timeout: float) -> Iterator[None]:
        """Hold the lock or raise ``LockTimeout`` after ``timeout`` seconds (0 = one try)."""
        deadline = time.monotonic() + max(0.0, timeout)
        if not self._local.acquire(timeout=max(0.0, timeout)):
            raise LockTimeout(f"lock busy: {os.path.basename(self.path)}")
        try:
            os.makedirs(os.path.dirname(self.path) or ".", mode=0o700, exist_ok=True)
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                while not _try_lock(fd):
                    if time.monotonic() >= deadline:
                        raise LockTimeout(f"lock busy: {os.path.basename(self.path)}")
                    time.sleep(0.005)
                try:
                    yield
                finally:
                    _unlock(fd)
            finally:
                os.close(fd)
        finally:
            self._local.release()


def _try_lock(fd: int) -> bool:
    if os.name == "nt":
        import msvcrt

        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    import fcntl

    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def _unlock(fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)


class ExclusiveLockFile:
    """The lock-file protocol shared with the plugin installer (``binding.mjs`` ``withRegistryLock``), used for
    the bindings registry ``hosts/.hermes-bindings.lock``. Node has no flock, so both sides exclude each other
    through the file's existence instead of a byte-range lock:

    * take it by creating the file with ``O_CREAT | O_EXCL`` (works on POSIX and Windows, no ``fcntl``);
    * write ``<pid> <hostname> <ms since epoch>`` into it;
    * a lock is stale, and broken (unlinked, then retried), when its mtime is older than ``STALE_S`` (60 s), or
      when it names a pid of this host that no longer runs (POSIX only) and it is at least 1 s old;
    * release by closing and unlinking it;
    * wait at most ``timeout`` seconds (polling every 25 ms), then raise ``LockTimeout``.

    A per-path ``threading.Lock`` keeps threads of this process in line (hook threads) before the file is touched.
    """

    STALE_S = 60.0
    POLL_S = 0.025

    def __init__(self, path: str) -> None:
        self.path = path
        key = os.path.normcase(os.path.abspath(path))
        with _GUARD:
            self._local = _PROCESS_LOCKS.setdefault(key, threading.Lock())

    @contextmanager
    def hold(self, timeout: float) -> Iterator[None]:
        deadline = time.monotonic() + max(0.0, timeout)
        if not self._local.acquire(timeout=max(0.0, timeout)):
            raise LockTimeout(f"lock busy: {os.path.basename(self.path)}")
        try:
            os.makedirs(os.path.dirname(self.path) or ".", mode=0o700, exist_ok=True)
            while True:
                try:
                    fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    break
                except FileExistsError:
                    if self._stale():
                        try:
                            os.unlink(self.path)
                        except FileNotFoundError:
                            pass
                        continue
                    if time.monotonic() >= deadline:
                        raise LockTimeout(f"lock busy: {os.path.basename(self.path)}") from None
                    time.sleep(self.POLL_S)
            try:
                try:
                    os.write(fd, f"{os.getpid()} {socket.gethostname()} {int(time.time() * 1000)}\n".encode())
                finally:
                    os.close(fd)
                yield
            finally:
                try:
                    os.unlink(self.path)
                except FileNotFoundError:
                    pass
        finally:
            self._local.release()

    def _stale(self) -> bool:
        try:
            age = time.time() - os.stat(self.path).st_mtime
        except OSError:
            return False  # gone meanwhile: the next O_EXCL try decides
        if age > self.STALE_S:
            return True
        try:
            with open(self.path, encoding="utf-8") as f:
                parts = f.read().split()
        except (OSError, UnicodeDecodeError):
            return False
        if len(parts) < 2 or not parts[0].isdigit() or parts[1] != socket.gethostname() or age < 1.0:
            return False
        if os.name == "nt":
            return False  # no cheap pid probe without ctypes; the 60 s rule still applies
        try:
            os.kill(int(parts[0]), 0)
            return False
        except ProcessLookupError:
            return True
        except OSError:
            return False
