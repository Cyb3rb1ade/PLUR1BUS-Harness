"""A bounded, cross-process file lock (stdlib only): a per-path lock in this process plus ``flock`` on
POSIX or ``msvcrt.locking`` on Windows, both taken with a deadline. Hook paths pass a short timeout and
skip their work on ``LockTimeout``; background work passes a long one."""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

__all__ = ["FileLock", "LockTimeout"]

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
