"""The bounded capture journal (HM2-R13 as amended by rulings F5, F6, F28).

``$HERMES_HOME/plur1bus/journal.ndjson`` (mode 0600, directory 0700) holds captures that failed for a
transport-class reason, one JSON object per line, oldest first. At most ``max_entries`` entries and
``max_bytes`` bytes; the oldest are dropped past that and counted. ``drain`` replays in order and stops
at the first transport-class failure; an entry the core refuses for a permanent reason is dropped and
counted as ``rejected`` so one bad turn never blocks the queue (F5).

This file is the only place message text is written (F6): log records, status and selftest output carry
codes and counts only. ``state.json`` next to it keeps the counters and the last error code for
``hermes plur1bus status``; it never holds text.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from .binding import atomic_write_text

__all__ = ["CaptureJournal", "JOURNAL_CODES", "JOURNAL_DIR", "JOURNAL_FILE", "is_journal_code"]

log = logging.getLogger("plur1bus")
log.addHandler(logging.NullHandler())  # records reach Hermes' handlers by propagation; no stderr fallback

JOURNAL_DIR = "plur1bus"
JOURNAL_FILE = "journal.ndjson"
STATE_FILE = "state.json"
#: Failures worth keeping a capture for: the core was not reached or did not answer, or the agent is
#: not bound yet (``hermes plur1bus bind`` fixes that). Everything else is permanent (F5).
JOURNAL_CODES = frozenset({"E_TRANSPORT", "E_TIMEOUT", "E_CORE_UNAVAILABLE", "E_SERVER_IDENTITY", "E_AGENT_UNKNOWN"})

_PROCESS_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()


def is_journal_code(code: object) -> bool:
    return isinstance(code, str) and code in JOURNAL_CODES


def _code_of(exc: BaseException) -> str | None:
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) else None


class CaptureJournal:
    def __init__(self, dir: str, *, max_entries: int = 1000, max_bytes: int = 4 * 1024 * 1024) -> None:  # noqa: A002
        self.dir = dir
        self.path = os.path.join(dir, JOURNAL_FILE)
        self.state_path = os.path.join(dir, STATE_FILE)
        self.lock_path = os.path.join(dir, ".lock")
        self.max_entries = int(max_entries)
        self.max_bytes = int(max_bytes)
        key = os.path.normcase(os.path.abspath(dir))
        with _PROCESS_LOCKS_GUARD:
            self._lock = _PROCESS_LOCKS.setdefault(key, threading.RLock())
        self._drain_lock = threading.Lock()

    @staticmethod
    def for_home(hermes_home: str, **kw: int) -> CaptureJournal:
        return CaptureJournal(os.path.join(hermes_home, JOURNAL_DIR), **kw)

    # -- locking ----------------------------------------------------------------------------------

    @contextmanager
    def _locked(self) -> Iterator[None]:
        """One writer at a time: a lock per directory in this process, plus an OS file lock across
        processes (a gateway and a CLI can share a profile)."""
        with self._lock:
            os.makedirs(self.dir, mode=0o700, exist_ok=True)
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                _os_lock(fd)
                try:
                    yield
                finally:
                    _os_unlock(fd)
            finally:
                os.close(fd)

    # -- storage ----------------------------------------------------------------------------------

    def _read_lines(self) -> list[bytes]:
        try:
            with open(self.path, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            return []
        return [ln for ln in data.split(b"\n") if ln.strip()]

    def _write_lines(self, lines: list[bytes]) -> None:
        if not lines:
            try:
                os.unlink(self.path)
            except FileNotFoundError:
                pass
            return
        atomic_write_text(self.path, b"".join(ln + b"\n" for ln in lines).decode("utf-8"))

    def _read_state(self) -> dict:
        try:
            with open(self.state_path, encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError):
            return {}
        return doc if isinstance(doc, dict) else {}

    def _bump(self, **counts: int) -> dict:
        state = self._read_state()
        for k, n in counts.items():
            state[k] = int(state.get(k, 0) or 0) + n
        atomic_write_text(self.state_path, json.dumps(state, sort_keys=True) + "\n")
        return state

    # -- API --------------------------------------------------------------------------------------

    def append(self, entry: dict) -> None:
        """Queue one capture (``entry`` is JSON-serialisable). Enforces the bounds, oldest dropped first."""
        entry = dict(entry)
        entry.setdefault("id", uuid.uuid4().hex)
        entry.setdefault("at", int(time.time() * 1000))
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self._locked():
            lines = self._read_lines()
            lines.append(line)
            dropped = 0
            total = sum(len(ln) + 1 for ln in lines)
            while lines and (len(lines) > self.max_entries or total > self.max_bytes):
                total -= len(lines[0]) + 1
                lines.pop(0)
                dropped += 1
            self._write_lines(lines)
            if dropped:
                self._bump(dropped=dropped)
        if dropped:
            log.warning("plur1bus: capture journal full, dropped %d oldest entr%s", dropped, "y" if dropped == 1 else "ies")

    def reject(self, n: int = 1) -> None:
        """Count a capture the core refused for a permanent reason (never queued, F5)."""
        with self._locked():
            self._bump(rejected=n)

    def note_error(self, code: str | None) -> None:
        """Remember the last error code for ``status`` (written only when it changes)."""
        with self._locked():
            state = self._read_state()
            if state.get("lastError") == code:
                return
            state["lastError"] = code
            state["lastErrorAt"] = int(time.time() * 1000) if code else None
            atomic_write_text(self.state_path, json.dumps(state, sort_keys=True) + "\n")

    def last_error(self) -> str | None:
        v = self._read_state().get("lastError")
        return v if isinstance(v, str) else None

    def counts(self) -> dict:
        """``{"queued", "dropped", "rejected"}``: entries waiting, entries dropped by the bounds, captures
        the core refused for good."""
        with self._lock:
            queued = len(self._read_lines())
            state = self._read_state()
        return {"queued": queued, "dropped": int(state.get("dropped", 0) or 0), "rejected": int(state.get("rejected", 0) or 0)}

    def drain(self, send: Callable[[dict], None]) -> int:
        """Replay queued entries oldest first with ``send``. Stops at the first transport-class failure
        (the entry stays); a permanent failure drops that entry, counts it and goes on. Returns the number
        delivered. Only one drain runs at a time per journal object; ``send`` runs without the lock held,
        so captures can be appended meanwhile."""
        if not self._drain_lock.acquire(blocking=False):
            return 0
        sent = 0
        try:
            while True:
                with self._locked():
                    lines = self._read_lines()
                if not lines:
                    return sent
                raw = lines[0]
                try:
                    entry = json.loads(raw)
                    if not isinstance(entry, dict):
                        raise ValueError("not an object")
                except ValueError:
                    self._remove(raw, rejected=True)
                    continue
                try:
                    send(entry)
                except Exception as e:  # noqa: BLE001 - classified below
                    code = _code_of(e)
                    if is_journal_code(code):
                        return sent
                    log.warning("plur1bus: dropped a journaled capture the core refused (%s)", code or type(e).__name__)
                    self._remove(raw, rejected=True)
                    continue
                self._remove(raw)
                sent += 1
        finally:
            self._drain_lock.release()

    def _remove(self, raw: bytes, *, rejected: bool = False) -> None:
        with self._locked():
            lines = self._read_lines()
            try:
                lines.remove(raw)  # by content: an eviction meanwhile may have removed it already
            except ValueError:
                pass
            else:
                self._write_lines(lines)
            if rejected:
                self._bump(rejected=1)


def _os_lock(fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        deadline = time.monotonic() + 10.0
        while True:
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX)


def _os_unlock(fd: int) -> None:
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
