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

__all__ = ["ExclusiveLockFile", "FileLock", "LockLost", "LockTimeout"]

_PROCESS_LOCKS: dict[str, threading.Lock] = {}
_GUARD = threading.Lock()


class LockTimeout(TimeoutError):
    """The lock was not free within the timeout (a ``TimeoutError``, so an ``OSError``)."""


class LockLost(OSError):
    """The lock file no longer holds this holder's nonce (it was judged stale and taken over): the critical
    section must not write."""


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


class _Held:
    def __init__(self, lock: "ExclusiveLockFile", nonce: str) -> None:
        self._lock = lock
        self.nonce = nonce

    def verify(self) -> None:
        """Raise ``LockLost`` unless the lock file still holds this holder's nonce. Call right before writing."""
        parts = self._lock._read_text()
        if parts is None or len(parts.split()) < 4 or parts.split()[3] != self.nonce:
            raise LockLost(f"lock lost: {os.path.basename(self._lock.path)}")


class ExclusiveLockFile:
    """The lock-file protocol shared with the plugin installer (``binding.mjs`` ``withRegistryLock``), used for
    the bindings registry ``hosts/.hermes-bindings.lock``. Node has no flock, so both sides exclude each other
    through the file's existence:

    * take it by creating the file with ``O_CREAT | O_EXCL`` (mode 0600; no ``fcntl``, so it works on Windows),
      write ``<pid> <hostname> <ms> <nonce>`` (nonce = 128-bit hex, unique per hold) and close the fd before the
      critical section. On Windows a ``PermissionError`` on create (name pending deletion) is retried like
      ``FileExistsError``;
    * a lock is stale when its mtime is older than ``STALE_S`` (60 s), or when it names a pid of this host that
      no longer runs (POSIX) and it is at least 1 s old. Breaking it: ``rename`` it to ``<lock>.break-<nonce>``,
      re-read the moved file and compare dev/inode and content with what was judged stale; equal -> unlink and
      retry O_EXCL; different (someone else broke it and a fresh lock took its place) -> put it back with
      ``os.link`` (never overwrites; ``EEXIST`` = just drop the break file);
    * release: ``rename`` to ``<lock>.rel-<nonce>``; unlink only when the content holds this holder's nonce,
      otherwise put it back as above (a stolen lock is never deleted);
    * before writing the protected data the holder calls ``held.verify()``: ``LockLost`` when its nonce is gone;
    * ``*.break-*`` / ``*.rel-*`` leftovers older than 60 s are removed;
    * wait at most ``timeout`` seconds (poll 25 ms), then ``LockTimeout``.

    A per-path ``threading.Lock`` keeps threads of this process in line before the file is touched.
    """

    STALE_S = 60.0
    DEAD_PID_MIN_AGE_S = 1.0
    POLL_S = 0.025

    def __init__(self, path: str) -> None:
        self.path = path
        key = os.path.normcase(os.path.abspath(path))
        with _GUARD:
            self._local = _PROCESS_LOCKS.setdefault(key, threading.Lock())

    @contextmanager
    def hold(self, timeout: float) -> Iterator[_Held]:
        deadline = time.monotonic() + max(0.0, timeout)
        if not self._local.acquire(timeout=max(0.0, timeout)):
            raise LockTimeout(f"lock busy: {os.path.basename(self.path)}")
        try:
            os.makedirs(os.path.dirname(self.path) or ".", mode=0o700, exist_ok=True)
            self._sweep()
            nonce = os.urandom(16).hex()
            while True:
                try:
                    fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    break
                except (FileExistsError, PermissionError) as e:
                    if isinstance(e, PermissionError) and os.name != "nt":
                        raise
                    judged = self._judge_stale()
                    if judged is not None:
                        self._break(*judged)
                        continue
                    if time.monotonic() >= deadline:
                        raise LockTimeout(f"lock busy: {os.path.basename(self.path)}") from None
                    time.sleep(self.POLL_S)
            try:
                os.write(fd, f"{os.getpid()} {socket.gethostname()} {int(time.time() * 1000)} {nonce}\n".encode())
            except BaseException:
                os.close(fd)
                self._release(nonce)
                raise
            os.close(fd)
            try:
                yield _Held(self, nonce)
            finally:
                self._release(nonce)
        finally:
            self._local.release()

    # -- internals ---------------------------------------------------------------------------------------

    def _read_text(self, path: str | None = None) -> str | None:
        try:
            with open(path or self.path, "rb") as f:
                return f.read().decode("utf-8", "replace")
        except OSError:
            return None

    def _judge_stale(self) -> tuple[os.stat_result, str] | None:
        try:
            st = os.stat(self.path)
        except OSError:
            return None  # gone meanwhile: the next O_EXCL try decides
        text = self._read_text()
        if text is None:
            return None
        age = time.time() - st.st_mtime
        if age > self.STALE_S:
            return st, text
        parts = text.split()
        if len(parts) < 2 or not parts[0].isdigit() or parts[1] != socket.gethostname() or age < self.DEAD_PID_MIN_AGE_S:
            return None
        if os.name == "nt":
            return None  # no cheap pid probe without ctypes; the 60 s rule still applies
        try:
            os.kill(int(parts[0]), 0)
            return None
        except ProcessLookupError:
            return st, text
        except OSError:
            return None

    def _break(self, st: os.stat_result, text: str) -> None:
        brk = f"{self.path}.break-{os.urandom(16).hex()}"
        try:
            os.rename(self.path, brk)
        except OSError:
            return  # gone, or (Windows) busy: the next round decides
        try:
            st2 = os.stat(brk)
        except OSError:
            return  # swept meanwhile; it was old
        same = (st2.st_dev, st2.st_ino) == (st.st_dev, st.st_ino) and self._read_text(brk) == text
        if same:
            self._unlink(brk)
        else:
            self._restore(brk)

    def _release(self, nonce: str) -> None:
        rel = f"{self.path}.rel-{nonce}"
        try:
            os.rename(self.path, rel)
        except OSError:
            return  # already gone (lost): nothing of ours to remove
        text = self._read_text(rel)
        parts = (text or "").split()
        if len(parts) >= 4 and parts[3] == nonce:
            self._unlink(rel)
        elif text is not None:
            self._restore(rel)

    def _restore(self, moved: str) -> None:
        """Put a lock that was moved aside by mistake back; ``os.link`` never overwrites a newer lock."""
        try:
            os.link(moved, self.path)
        except OSError:  # FileExistsError: a new lock exists, the moved one is obsolete
            pass
        self._unlink(moved)

    @staticmethod
    def _unlink(path: str) -> None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass

    def _sweep(self) -> None:
        d = os.path.dirname(self.path) or "."
        base = os.path.basename(self.path)
        try:
            names = os.listdir(d)
        except OSError:
            return
        now = time.time()
        for n in names:
            if n.startswith((base + ".break-", base + ".rel-")):
                try:
                    if now - os.stat(os.path.join(d, n)).st_mtime > self.STALE_S:
                        self._unlink(os.path.join(d, n))
                except OSError:
                    pass
