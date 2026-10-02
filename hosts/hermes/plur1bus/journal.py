"""The bounded capture journal (HM2-R13 as amended by rulings F5, F6, F28).

``$HERMES_HOME/plur1bus/journal.ndjson`` (mode 0600, directory 0700) holds captures that failed for a
transport-class reason, one JSON object per line, oldest first. At most ``max_entries`` entries and
``max_bytes`` bytes; the oldest are dropped past that and counted. ``drain`` replays in order and stops
at the first transport-class failure; an entry the core refuses for a permanent reason is dropped and
counted as ``rejected`` so one bad turn never blocks the queue (F5).

Appends within the bounds are ``O_APPEND`` writes; the file is rewritten only to trim it and once per
drain batch. Every lock is taken with a timeout (``_filelock``); the provider calls the journal only
from its background worker, or from ``shutdown`` with a short timeout.

This file is the only place message text is written (F6): log records, status and selftest output carry
codes and counts only. ``state.json`` next to it keeps the counters and the last error code for
``hermes plur1bus status``; it never holds text.

Windows: a file being replaced (``os.replace`` of a rewrite) or deleted, or held open by a reader without
``FILE_SHARE_DELETE`` (CPython's ``open``), refuses other opens, renames and unlinks for a moment with a
sharing/access error. The journal's own readers open with ``FILE_SHARE_DELETE`` so they never block a
rewrite; and every journal and state open, unlink and size check retries those
(``PermissionError`` with winerror 5/32/33 or errno EACCES/EPERM/EBUSY) with backoff 10 ms doubling to
100 ms, for at most 2 s (the ``_filelock`` release policy). The lock-free readers (``counts``,
``last_error``) never raise: past the budget they report what they could read.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import time
import uuid
from collections.abc import Callable
from typing import TypeVar

from ._filelock import FileLock, LockTimeout
from .binding import atomic_write_text

__all__ = ["CaptureJournal", "JOURNAL_CODES", "JOURNAL_DIR", "JOURNAL_FILE", "LockTimeout", "is_journal_code"]

log = logging.getLogger("plur1bus")
log.addHandler(logging.NullHandler())  # records reach Hermes' handlers by propagation; no stderr fallback

JOURNAL_DIR = "plur1bus"
JOURNAL_FILE = "journal.ndjson"
STATE_FILE = "state.json"
#: Failures worth keeping a capture for: the core was not reached or did not answer, or the agent is
#: not bound yet (``hermes plur1bus bind`` fixes that). Everything else is permanent (F5).
JOURNAL_CODES = frozenset({"E_TRANSPORT", "E_TIMEOUT", "E_CORE_UNAVAILABLE", "E_SERVER_IDENTITY", "E_AGENT_UNKNOWN"})
#: Background default: long enough for another process's rewrite, never forever.
DEFAULT_LOCK_TIMEOUT_S = 10.0
DRAIN_BATCH = 50


def is_journal_code(code: object) -> bool:
    return isinstance(code, str) and code in JOURNAL_CODES


_T = TypeVar("_T")
_WINDOWS = os.name == "nt"
_SHARING_WINERRORS = (5, 32, 33)  # ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
_SHARING_ERRNOS = (errno.EACCES, errno.EPERM, errno.EBUSY)
SHARING_RETRY_S = 2.0


def _sharing_retry(op: Callable[[], _T], budget_s: float | None = None) -> _T:
    """Run ``op``; on Windows retry a sharing/access ``PermissionError`` for up to ``budget_s`` (backoff 10 ms
    doubling to 100 ms), then re-raise. Elsewhere, and for every other error, no retry."""
    deadline = time.monotonic() + (SHARING_RETRY_S if budget_s is None else budget_s)
    delay = 0.01
    while True:
        try:
            return op()
        except PermissionError as e:
            transient = getattr(e, "winerror", None) in _SHARING_WINERRORS or e.errno in _SHARING_ERRNOS
            if not _WINDOWS or not transient or time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.1)


def _read_bytes(path: str) -> bytes:
    return _sharing_retry(lambda: _read_once(path))


def _read_once(path: str) -> bytes:
    if os.name == "nt":
        return _read_shared_nt(path)
    with open(path, "rb") as f:
        return f.read()


def _read_shared_nt(path: str) -> bytes:
    """Read with ``FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE``: unlike CPython's ``open``, a reader
    then never makes the writer's ``os.replace`` or ``unlink`` fail. Errors map to ``FileNotFoundError`` /
    ``PermissionError`` like ``open``'s."""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    generic_read, share_all, open_existing, normal = 0x80000000, 0x7, 3, 0x80
    h = k32.CreateFileW(path, generic_read, share_all, None, open_existing, normal, None)
    if h is None or h == wintypes.HANDLE(-1).value:
        err = ctypes.get_last_error()
        raise OSError(None, ctypes.FormatError(err).strip(), path, err)  # winerror -> errno and subclass
    fd = msvcrt.open_osfhandle(h, os.O_RDONLY)  # owns h from here on
    with os.fdopen(fd, "rb") as f:
        return f.read()


def _code_of(exc: BaseException) -> str | None:
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) else None


class CaptureJournal:
    def __init__(self, dir: str, *, max_entries: int = 1000, max_bytes: int = 4 * 1024 * 1024) -> None:  # noqa: A002
        self.dir = dir
        self.path = os.path.join(dir, JOURNAL_FILE)
        self.state_path = os.path.join(dir, STATE_FILE)
        self.max_entries = int(max_entries)
        self.max_bytes = int(max_bytes)
        self._lock = FileLock(os.path.join(dir, ".lock"))

    @staticmethod
    def for_home(hermes_home: str, **kw: int) -> CaptureJournal:
        return CaptureJournal(os.path.join(hermes_home, JOURNAL_DIR), **kw)

    # -- storage ----------------------------------------------------------------------------------

    def _read_lines(self) -> list[bytes]:
        try:
            data = _read_bytes(self.path)
        except FileNotFoundError:
            return []
        return [ln for ln in data.split(b"\n") if ln.strip()]

    def _write_lines(self, lines: list[bytes]) -> None:
        if not lines:
            try:
                _sharing_retry(lambda: os.unlink(self.path))
            except FileNotFoundError:
                pass
            return
        atomic_write_text(self.path, b"".join(ln + b"\n" for ln in lines).decode("utf-8"))

    def _append_line(self, line: bytes) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_BINARY", 0)
        fd = _sharing_retry(lambda: os.open(self.path, flags, 0o600))
        try:
            os.write(fd, line + b"\n")
            os.fsync(fd)
        finally:
            os.close(fd)

    def _read_state(self, *, strict: bool = False) -> dict:
        """The counters. A missing or corrupt file is ``{}``. Any other read error past the sharing retries is
        ``{}`` for readers, but raised when ``strict`` (a read-modify-write must not reset the counters)."""
        try:
            doc = json.loads(_read_bytes(self.state_path).decode("utf-8"))
        except FileNotFoundError:
            return {}
        except ValueError:  # includes UnicodeDecodeError
            return {}
        except OSError:
            if strict:
                raise
            return {}
        return doc if isinstance(doc, dict) else {}

    def _bump_locked(self, **counts: int) -> None:
        state = self._read_state(strict=True)
        for k, n in counts.items():
            state[k] = int(state.get(k, 0) or 0) + n
        atomic_write_text(self.state_path, json.dumps(state, sort_keys=True) + "\n")

    # -- API --------------------------------------------------------------------------------------

    def append(self, entry: dict, *, timeout: float = DEFAULT_LOCK_TIMEOUT_S) -> None:
        """Queue one capture (``entry`` is JSON-serialisable). Enforces the bounds, oldest dropped first.
        Raises ``LockTimeout`` (nothing written) when the lock stays busy past ``timeout``."""
        entry = dict(entry)
        entry.setdefault("id", uuid.uuid4().hex)
        entry.setdefault("at", int(time.time() * 1000))
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        dropped = 0
        with self._lock.hold(timeout):
            try:
                size = _sharing_retry(lambda: os.path.getsize(self.path))
            except FileNotFoundError:
                size = 0
            fits_bytes = size + len(line) + 1 <= self.max_bytes
            lines = self._read_lines() if not fits_bytes or size else []
            if fits_bytes and len(lines) + 1 <= self.max_entries:
                self._append_line(line)
            else:
                lines.append(line)
                total = sum(len(ln) + 1 for ln in lines)
                while lines and (len(lines) > self.max_entries or total > self.max_bytes):
                    total -= len(lines[0]) + 1
                    lines.pop(0)
                    dropped += 1
                self._write_lines(lines)
                self._bump_locked(dropped=dropped)
        if dropped:
            log.warning("plur1bus: capture journal full, dropped %d oldest entr%s", dropped, "y" if dropped == 1 else "ies")

    def bump(self, *, timeout: float = DEFAULT_LOCK_TIMEOUT_S, **counts: int) -> None:
        """Add to the counters in ``state.json`` (``rejected``, ``lost``, ...)."""
        with self._lock.hold(timeout):
            self._bump_locked(**counts)

    def reject(self, n: int = 1, *, timeout: float = DEFAULT_LOCK_TIMEOUT_S) -> None:
        """Count a capture the core refused for a permanent reason (never queued, F5)."""
        self.bump(timeout=timeout, rejected=n)

    def note_error(self, code: str | None, *, timeout: float = DEFAULT_LOCK_TIMEOUT_S) -> None:
        """Remember the last error code for ``status`` (written only when it changes)."""
        with self._lock.hold(timeout):
            state = self._read_state(strict=True)
            if state.get("lastError") == code:
                return
            state["lastError"] = code
            state["lastErrorAt"] = int(time.time() * 1000) if code else None
            atomic_write_text(self.state_path, json.dumps(state, sort_keys=True) + "\n")

    def last_error(self) -> str | None:
        v = self._read_state().get("lastError")
        return v if isinstance(v, str) else None

    def counts(self) -> dict:
        """``{"queued", "dropped", "rejected", "lost"}``: entries waiting, entries dropped by the bounds,
        captures the core refused for good, captures that could not be journaled at all. Lock-free read
        (a rewrite is an atomic rename); never raises: a journal still unreadable after the Windows sharing
        retries counts as 0 queued (logged)."""
        state = self._read_state()
        try:
            queued = len(self._read_lines())
        except OSError as e:
            log.info("plur1bus: could not read the capture journal (%s)", type(e).__name__)
            queued = 0
        return {
            "queued": queued,
            "dropped": int(state.get("dropped", 0) or 0),
            "rejected": int(state.get("rejected", 0) or 0),
            "lost": int(state.get("lost", 0) or 0),
        }

    def drain(self, send: Callable[[dict], None], *, batch: int = DRAIN_BATCH, timeout: float = DEFAULT_LOCK_TIMEOUT_S) -> int:
        """Replay queued entries oldest first with ``send``. Stops at the first transport-class failure
        (that entry stays); a permanent failure drops the entry, counts it and goes on. The file is
        rewritten once per batch of ``batch`` entries, and ``send`` runs without the lock, so appends
        continue meanwhile. Returns the number delivered. A crash mid-batch re-sends that batch
        (at-least-once)."""
        sent = 0
        while True:
            snapshot = self._read_lines()[: max(1, batch)]
            if not snapshot:
                return sent
            done: list[bytes] = []
            rejected = 0
            stop = False
            for raw in snapshot:
                try:
                    entry = json.loads(raw)
                    if not isinstance(entry, dict):
                        raise ValueError("not an object")
                except ValueError:
                    done.append(raw)
                    rejected += 1
                    continue
                try:
                    send(entry)
                except Exception as e:  # noqa: BLE001 - classified below
                    code = _code_of(e)
                    if is_journal_code(code):
                        stop = True
                        break
                    log.warning("plur1bus: dropped a journaled capture the core refused (%s)", code or type(e).__name__)
                    done.append(raw)
                    rejected += 1
                    continue
                done.append(raw)
                sent += 1
            if done:
                with self._lock.hold(timeout):
                    lines = self._read_lines()
                    for raw in done:
                        try:
                            lines.remove(raw)  # by content: an eviction meanwhile may have removed it already
                        except ValueError:
                            pass
                    self._write_lines(lines)
                    if rejected:
                        self._bump_locked(rejected=rejected)
            if stop:
                return sent
