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
import re
import stat
import time
import uuid
import zlib
from collections.abc import Callable
from typing import Any, TypeVar

from ._filelock import FileLock, LockTimeout
from .binding import atomic_write_text

__all__ = [
    "JOURNAL_CODES",
    "JOURNAL_DIR",
    "JOURNAL_FILE",
    "CaptureJournal",
    "LockTimeout",
    "clean_code",
    "is_journal_code",
    "is_journal_error",
]

log = logging.getLogger("plur1bus")
log.addHandler(logging.NullHandler())  # records reach Hermes' handlers by propagation; no stderr fallback

JOURNAL_DIR = "plur1bus"
JOURNAL_FILE = "journal.ndjson"
STATE_FILE = "state.json"
DEAD_LETTER_FILE = "dead-letter.ndjson"
#: Failures worth keeping a capture for: the core was not reached or did not answer. Everything else is
#: permanent (F5), ``E_AGENT_UNKNOWN`` included (audit M3): a queue that waited for a ``bind`` that may never
#: come would stall every later turn of the home. Permanent entries go to the bounded dead-letter file.
JOURNAL_CODES = frozenset({"E_TRANSPORT", "E_TIMEOUT", "E_CORE_UNAVAILABLE", "E_SERVER_IDENTITY"})
DEAD_LETTER_MAX_ENTRIES = 200
DEAD_LETTER_MAX_BYTES = 1024 * 1024
_CODE_MAX = 64
_CODE_BAD = re.compile(r"[^A-Za-z0-9_.-]")
#: Background default: long enough for another process's rewrite, never forever.
DEFAULT_LOCK_TIMEOUT_S = 10.0
DRAIN_BATCH = 50


def is_journal_code(code: object) -> bool:
    return isinstance(code, str) and code in JOURNAL_CODES


def is_journal_error(exc: object, code: object = None) -> bool:
    """True when a failed capture should be journaled and retried later instead of being set aside.

    Besides the transport codes, this covers the client's local-endpoint trust refusal: since the memory client
    reports an untrusted run/ or socket as ``E_UNAUTHORIZED`` with ``data["legacy_code"] == "E_SERVER_IDENTITY"``
    (trust.is_trust_refusal), the same condition that used to be ``E_SERVER_IDENTITY``. It is local and fixable
    (wrong owner or mode of run/), so the turn stays in the 0600 journal and is sent once the endpoint is trusted.
    A plain ``E_UNAUTHORIZED`` from the core (bad token) is not journaled.
    """
    if code is None:
        code = getattr(exc, "code", None)
    if is_journal_code(code):
        return True
    data = getattr(exc, "data", None)
    return code == "E_UNAUTHORIZED" and isinstance(data, dict) and data.get("legacy_code") == "E_SERVER_IDENTITY"


def clean_code(code: object) -> str | None:
    """A core-supplied error code reduced to ``[A-Za-z0-9_.-]{1,64}`` (anything else becomes ``?``), so logs and
    ``state.json`` stay bounded whatever the peer sends. Non-strings and empty strings are ``None``."""
    if not isinstance(code, str) or not code:
        return None
    return _CODE_BAD.sub("?", code)[:_CODE_MAX]


def _int(v: object) -> int:
    """A counter from ``state.json``: a non-negative int, else 0 (the file may hold anything)."""
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        return 0
    return v


def _frame(payload: bytes) -> bytes:
    """``P1 <length> <crc32> <payload>``: a torn or flipped record fails the check and is skipped."""
    return b"P1 %d %08x " % (len(payload), zlib.crc32(payload) & 0xFFFFFFFF) + payload


def _unframe(line: bytes) -> bytes | None:
    """The payload of one line: a valid frame, a legacy unframed JSON line, or ``None`` (damaged)."""
    if not line.startswith(b"P1 "):
        return line if line.lstrip().startswith(b"{") else None
    parts = line.split(b" ", 3)
    if len(parts) != 4:
        return None
    try:
        n, crc = int(parts[1]), int(parts[2], 16)
    except ValueError:
        return None
    payload = parts[3]
    if len(payload) != n or zlib.crc32(payload) & 0xFFFFFFFF != crc:
        return None
    return payload


_T = TypeVar("_T")
_WINDOWS = os.name == "nt"
_SHARING_WINERRORS = (
    5,
    32,
    33,
)  # ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
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

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    generic_read, share_all, open_existing, normal = 0x80000000, 0x7, 3, 0x80
    h = k32.CreateFileW(path, generic_read, share_all, None, open_existing, normal, None)
    if h is None or h == wintypes.HANDLE(-1).value:
        err = ctypes.get_last_error()  # type: ignore[attr-defined]
        message = ctypes.FormatError(err).strip()  # type: ignore[attr-defined]
        raise OSError(None, message, path, err)  # winerror -> errno and subclass
    fd = msvcrt.open_osfhandle(h, os.O_RDONLY)  # type: ignore[attr-defined]  # owns h from here on
    with os.fdopen(fd, "rb") as f:
        return f.read()


def _code_of(exc: BaseException) -> str | None:
    return clean_code(getattr(exc, "code", None))


class CaptureJournal:
    def __init__(
        self,
        dir: str,
        *,
        max_entries: int = 1000,
        max_bytes: int = 4 * 1024 * 1024,
        dead_letter_max_entries: int = DEAD_LETTER_MAX_ENTRIES,
        dead_letter_max_bytes: int = DEAD_LETTER_MAX_BYTES,
    ) -> None:
        self.dir = dir
        self.path = os.path.join(dir, JOURNAL_FILE)
        self.state_path = os.path.join(dir, STATE_FILE)
        self.dead_letter_path = os.path.join(dir, DEAD_LETTER_FILE)
        self.max_entries = int(max_entries)
        self.max_bytes = int(max_bytes)
        self.dead_letter_max_entries = int(dead_letter_max_entries)
        self.dead_letter_max_bytes = int(dead_letter_max_bytes)
        self._lock = FileLock(os.path.join(dir, ".lock"))

    @staticmethod
    def for_home(hermes_home: str, **kw: int) -> CaptureJournal:
        return CaptureJournal(os.path.join(hermes_home, JOURNAL_DIR), **kw)

    # -- storage ----------------------------------------------------------------------------------

    def _secure(self) -> None:
        """Called under the lock before every write: the directory must be ours and 0700, the files 0600
        (a loose mode is repaired, not only set at creation; a directory owned by someone else is refused)."""
        if os.name != "posix":
            return
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        st = os.lstat(self.dir)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid():
            raise PermissionError(
                errno.EACCES,
                "the journal directory is not a directory owned by this user",
                self.dir,
            )
        if st.st_mode & 0o077:
            os.chmod(self.dir, 0o700)
        for f in (self.path, self.state_path, self.dead_letter_path):
            try:
                fst = os.lstat(f)
            except FileNotFoundError:
                continue
            if fst.st_mode & 0o077 and stat.S_ISREG(fst.st_mode):
                os.chmod(f, 0o600)

    def _scan(self) -> tuple[list[bytes], int]:
        """The valid payloads of the journal, oldest first, and how many damaged records were skipped."""
        return self._scan_file(self.path)

    @staticmethod
    def _scan_file(path: str) -> tuple[list[bytes], int]:
        try:
            data = _read_bytes(path)
        except FileNotFoundError:
            return [], 0
        out: list[bytes] = []
        damaged = 0
        for ln in data.split(b"\n"):
            if not ln.strip():
                continue
            payload = _unframe(ln)
            if payload is None:
                damaged += 1
            else:
                out.append(payload)
        return out, damaged

    def _read_lines(self) -> list[bytes]:
        return self._scan()[0]

    def _write_file(self, path: str, payloads: list[bytes]) -> None:
        if not payloads:
            try:
                _sharing_retry(lambda: os.unlink(path))
            except FileNotFoundError:
                pass
            return
        atomic_write_text(path, b"".join(_frame(p) + b"\n" for p in payloads).decode("utf-8"))

    def _write_lines(self, lines: list[bytes]) -> None:
        self._write_file(self.path, lines)

    def _append_line(self, line: bytes) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_BINARY", 0)
        fd = _sharing_retry(lambda: os.open(self.path, flags, 0o600))
        try:
            # A crash can leave half a record with no newline; close it so it cannot swallow this entry.
            os.write(fd, (b"\n" if self._unterminated() else b"") + _frame(line) + b"\n")
            os.fsync(fd)
        finally:
            os.close(fd)

    def _unterminated(self) -> bool:
        try:
            with open(self.path, "rb") as f:
                f.seek(0, os.SEEK_END)
                if f.tell() == 0:
                    return False
                f.seek(-1, os.SEEK_END)
                return f.read(1) != b"\n"
        except OSError:
            return False

    def _read_state(self, *, strict: bool = False) -> dict[str, Any]:
        """The counters. A missing or corrupt file is ``{}``. Any other read error past the sharing retries is
        ``{}`` for readers, but raised when ``strict`` (a read-modify-write must not reset the counters)."""
        try:
            doc = json.loads(_read_bytes(self.state_path).decode("utf-8"))
        except FileNotFoundError:
            return {}
        except ValueError:  # includes UnicodeDecodeError
            log.warning("plur1bus: the journal state file is malformed; its counters read as 0")
            return {}
        except OSError:
            if strict:
                raise
            return {}
        return doc if isinstance(doc, dict) else {}

    def _bump_locked(self, **counts: int) -> None:
        state = self._read_state(strict=True)
        for k, n in counts.items():
            state[k] = _int(state.get(k)) + n
        atomic_write_text(self.state_path, json.dumps(state, sort_keys=True) + "\n")

    # -- API --------------------------------------------------------------------------------------

    def append(self, entry: dict[str, Any], *, timeout: float = DEFAULT_LOCK_TIMEOUT_S) -> None:
        """Queue one capture (``entry`` is JSON-serialisable). Enforces the bounds, oldest dropped first.
        Raises ``LockTimeout`` (nothing written) when the lock stays busy past ``timeout``."""
        entry = dict(entry)
        entry.setdefault("id", uuid.uuid4().hex)
        entry.setdefault("at", int(time.time() * 1000))
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        dropped = 0
        with self._lock.hold(timeout):
            self._secure()
            try:
                size = _sharing_retry(lambda: os.path.getsize(self.path))
            except FileNotFoundError:
                size = 0
            fits_bytes = size + len(_frame(line)) + 2 <= self.max_bytes
            lines = self._read_lines() if not fits_bytes or size else []
            if fits_bytes and len(lines) + 1 <= self.max_entries:
                self._append_line(line)
            else:
                lines.append(line)
                total = sum(len(_frame(ln)) + 1 for ln in lines)
                while lines and (len(lines) > self.max_entries or total > self.max_bytes):
                    total -= len(_frame(lines[0])) + 1
                    lines.pop(0)
                    dropped += 1
                self._write_lines(lines)
                self._bump_locked(dropped=dropped)
        if dropped:
            log.warning(
                "plur1bus: capture journal full, dropped %d oldest entr%s",
                dropped,
                "y" if dropped == 1 else "ies",
            )

    def bump(self, *, timeout: float = DEFAULT_LOCK_TIMEOUT_S, **counts: int) -> None:
        """Add to the counters in ``state.json`` (``rejected``, ``lost``, ...)."""
        with self._lock.hold(timeout):
            self._secure()
            self._bump_locked(**counts)

    def dead_letter(
        self,
        entry: dict[str, Any],
        code: str | None,
        *,
        timeout: float = DEFAULT_LOCK_TIMEOUT_S,
    ) -> None:
        """Keep a capture the core refused for good (audit M3), with its error code, in the bounded 0600
        dead-letter file instead of blocking the queue; counted as ``deadLettered`` and ``rejected``."""
        with self._lock.hold(timeout):
            self._secure()
            self._dead_letter_locked([(entry, code)])
            self._bump_locked(deadLettered=1, rejected=1)

    def _dead_letter_locked(self, items: list[tuple[dict[str, Any], str | None]]) -> None:
        records, _ = self._scan_file(self.dead_letter_path)
        now = int(time.time() * 1000)
        for entry, code in items:
            records.append(
                json.dumps(
                    {
                        "at": now,
                        "code": clean_code(code) or "E_UNKNOWN",
                        "entry": entry,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
        total = sum(len(_frame(r)) + 1 for r in records)
        while records and (len(records) > self.dead_letter_max_entries or total > self.dead_letter_max_bytes):
            total -= len(_frame(records[0])) + 1
            records.pop(0)
        self._write_file(self.dead_letter_path, records)

    def dead_letters(self) -> list[dict[str, Any]]:
        """The dead-letter records (``{at, code, entry}``), oldest first."""
        out = []
        for raw in self._scan_file(self.dead_letter_path)[0]:
            try:
                doc = json.loads(raw)
            except ValueError:
                continue
            if isinstance(doc, dict):
                out.append(doc)
        return out

    def details(self) -> dict[str, Any]:
        """Counters beyond ``counts()``: ``deadLettered`` (permanent refusals kept aside) and ``damaged``
        (journal records skipped because their frame did not check out)."""
        state = self._read_state()
        return {
            "deadLettered": _int(state.get("deadLettered")),
            "damaged": _int(state.get("damaged")),
        }

    def reject(self, n: int = 1, *, timeout: float = DEFAULT_LOCK_TIMEOUT_S) -> None:
        """Count a capture the core refused for a permanent reason (never queued, F5)."""
        self.bump(timeout=timeout, rejected=n)

    def note_error(self, code: str | None, *, timeout: float = DEFAULT_LOCK_TIMEOUT_S) -> None:
        """Remember the last error code for ``status`` (written only when it changes)."""
        code = clean_code(code)
        with self._lock.hold(timeout):
            self._secure()
            state = self._read_state(strict=True)
            if state.get("lastError") == code:
                return
            state["lastError"] = code
            state["lastErrorAt"] = int(time.time() * 1000) if code else None
            atomic_write_text(self.state_path, json.dumps(state, sort_keys=True) + "\n")

    def last_error(self) -> str | None:
        return clean_code(self._read_state().get("lastError"))

    def counts(self) -> dict[str, int]:
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
            "dropped": _int(state.get("dropped")),
            "rejected": _int(state.get("rejected")),
            "lost": _int(state.get("lost")),
        }

    def drain(
        self,
        send: Callable[[dict[str, Any]], None],
        *,
        batch: int = DRAIN_BATCH,
        timeout: float = DEFAULT_LOCK_TIMEOUT_S,
    ) -> int:
        """Replay queued entries oldest first with ``send``. Stops at the first transport-class failure
        (that entry stays); a permanent failure drops the entry, counts it and goes on. The file is
        rewritten once per batch of ``batch`` entries, and ``send`` runs without the lock, so appends
        continue meanwhile. Returns the number delivered. A crash mid-batch re-sends that batch
        (at-least-once)."""
        sent = 0
        while True:
            lines, damaged = self._scan()
            snapshot = lines[: max(1, batch)]
            if not snapshot:
                if damaged:  # nothing valid left: the damaged remainder is dropped and counted
                    with self._lock.hold(timeout):
                        self._secure()
                        self._write_lines(self._read_lines())
                        self._bump_locked(damaged=damaged)
                return sent
            done: list[bytes] = []
            dead: list[tuple[dict[str, Any], str | None]] = []
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
                    if is_journal_error(e, code):
                        stop = True
                        break
                    log.warning(
                        "plur1bus: set aside a journaled capture the core refused (%s)",
                        code or type(e).__name__,
                    )
                    done.append(raw)
                    dead.append((entry, code or type(e).__name__))
                    continue
                done.append(raw)
                sent += 1
            if done or damaged:
                with self._lock.hold(timeout):
                    self._secure()
                    lines = self._read_lines()
                    for raw in done:
                        try:
                            lines.remove(raw)  # by content: an eviction meanwhile may have removed it already
                        except ValueError:
                            pass
                    if dead:
                        self._dead_letter_locked(dead)
                    self._write_lines(lines)  # rewrites framed and without any damaged record
                    counts: dict[str, int] = {}
                    if rejected or dead:
                        counts["rejected"] = rejected + len(dead)
                    if dead:
                        counts["deadLettered"] = len(dead)
                    if damaged:
                        counts["damaged"] = damaged
                    if counts:
                        self._bump_locked(**counts)
            if stop:
                return sent
