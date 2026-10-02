import json
import os
import shutil
import tempfile
import errno
import threading
import time
import unittest
from unittest import mock

import plur1bus.journal as journal_mod
from plur1bus._client import pmc
from plur1bus.journal import JOURNAL_CODES, CaptureJournal


def _entry(i: int, size: int = 10) -> dict:
    return {"agentId": "hermes-test", "messages": [{"role": "user", "content": f"turn {i} " + "x" * size}]}


class JournalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = os.path.join(tempfile.mkdtemp(prefix="p1h-j-"), "plur1bus")
        self.addCleanup(shutil.rmtree, os.path.dirname(self.dir), ignore_errors=True)

    def test_append_and_drain_in_order(self) -> None:
        j = CaptureJournal(self.dir)
        for i in range(3):
            j.append(_entry(i))
        self.assertEqual(j.counts(), {"queued": 3, "dropped": 0, "rejected": 0, "lost": 0})
        sent = []
        self.assertEqual(j.drain(lambda e: sent.append(e["messages"][0]["content"].split(" ")[1])), 3)
        self.assertEqual(sent, ["0", "1", "2"])
        self.assertEqual(j.counts()["queued"], 0)
        self.assertFalse(os.path.exists(j.path), "an empty journal leaves no file")

    def test_entry_bound_drops_oldest_and_counts(self) -> None:
        j = CaptureJournal(self.dir, max_entries=3)
        with self.assertLogs("plur1bus", "WARNING") as logs:
            for i in range(5):
                j.append(_entry(i))
        self.assertEqual(j.counts(), {"queued": 3, "dropped": 2, "rejected": 0, "lost": 0})
        sent = []
        j.drain(lambda e: sent.append(e["messages"][0]["content"].split(" ")[1]))
        self.assertEqual(sent, ["2", "3", "4"])
        self.assertTrue(all("turn" not in m for m in logs.output), "log lines carry counts, never text")

    def test_byte_bound_drops_oldest_and_counts(self) -> None:
        j = CaptureJournal(self.dir, max_bytes=1000)
        for i in range(10):
            j.append(_entry(i, size=300))
        c = j.counts()
        self.assertLessEqual(os.path.getsize(j.path), 1000)
        self.assertEqual(c["queued"] + c["dropped"], 10)
        self.assertGreater(c["dropped"], 0)
        # Counters survive a new journal object (a second process reading status).
        self.assertEqual(CaptureJournal(self.dir).counts(), c)

    def test_drain_stops_at_the_first_transport_failure(self) -> None:
        j = CaptureJournal(self.dir)
        for i in range(3):
            j.append(_entry(i))
        seen = []

        def send(e: dict) -> None:
            seen.append(e["messages"][0]["content"].split(" ")[1])
            if len(seen) == 2:
                raise pmc.RpcError("E_CORE_UNAVAILABLE", "down")

        self.assertEqual(j.drain(send), 1)
        self.assertEqual(seen, ["0", "1"])
        self.assertEqual(j.counts(), {"queued": 2, "dropped": 0, "rejected": 0, "lost": 0}, "the failed entry stays at the head")
        self.assertEqual(sorted(JOURNAL_CODES), ["E_AGENT_UNKNOWN", "E_CORE_UNAVAILABLE", "E_SERVER_IDENTITY", "E_TIMEOUT", "E_TRANSPORT"])

    def test_poison_head_does_not_block_replay(self) -> None:
        j = CaptureJournal(self.dir)
        for i in range(3):
            j.append(_entry(i))
        sent = []

        def send(e: dict) -> None:
            n = e["messages"][0]["content"].split(" ")[1]
            if n == "0":
                raise pmc.RpcError("E_INVALID_PARAMS", "refused for good")
            sent.append(n)

        self.assertEqual(j.drain(send), 2)
        self.assertEqual(sent, ["1", "2"])
        self.assertEqual(j.counts(), {"queued": 0, "dropped": 0, "rejected": 1, "lost": 0})

    def test_a_corrupt_line_is_dropped_and_counted(self) -> None:
        j = CaptureJournal(self.dir)
        j.append(_entry(0))
        with open(j.path, "ab") as f:
            f.write(b"{broken\n")
        j.append(_entry(1))
        sent = []
        j.drain(lambda e: sent.append(e["messages"][0]["content"].split(" ")[1]))
        self.assertEqual(sent, ["0", "1"])
        self.assertEqual(j.counts()["rejected"], 1)

    def test_appends_during_a_drain_are_kept(self) -> None:
        j = CaptureJournal(self.dir)
        j.append(_entry(0))
        sent = []

        def send(e: dict) -> None:
            n = e["messages"][0]["content"].split(" ")[1]
            sent.append(n)
            if n == "0":
                t = threading.Thread(target=j.append, args=(_entry(1),))
                t.start()
                t.join()

        j.drain(send)
        self.assertEqual(sent, ["0", "1"])
        self.assertEqual(j.counts()["queued"], 0)

    def test_drain_rewrites_once_per_batch(self) -> None:
        from plur1bus import journal as journal_mod

        j = CaptureJournal(self.dir)
        for i in range(120):
            j.append(_entry(i))
        writes = []
        real = journal_mod.atomic_write_text

        def counting(path, *a, **kw):  # noqa: ANN001, ANN002, ANN003
            writes.append(os.path.basename(path))
            return real(path, *a, **kw)

        sent = []
        from unittest import mock

        with mock.patch.object(journal_mod, "atomic_write_text", counting):
            self.assertEqual(j.drain(lambda e: sent.append(1), batch=50), 120)
        self.assertEqual(len(sent), 120)
        self.assertLessEqual(writes.count("journal.ndjson"), 2, "120 entries in batches of 50: at most 2 rewrites (the last empties the file)")
        self.assertEqual(j.counts()["queued"], 0)

    def test_appends_within_bounds_do_not_rewrite(self) -> None:
        from unittest import mock

        from plur1bus import journal as journal_mod

        j = CaptureJournal(self.dir)
        with mock.patch.object(journal_mod, "atomic_write_text", side_effect=AssertionError("rewrite")):
            for i in range(5):
                j.append(_entry(i))
        self.assertEqual(j.counts()["queued"], 5)

    def test_a_busy_lock_times_out_without_writing(self) -> None:
        from plur1bus import _filelock

        j = CaptureJournal(self.dir)
        j.append(_entry(0))
        fd = os.open(os.path.join(self.dir, ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        self.assertTrue(_filelock._try_lock(fd))
        try:
            with self.assertRaises(_filelock.LockTimeout):
                j.append(_entry(1), timeout=0.1)
        finally:
            _filelock._unlock(fd)
            os.close(fd)
        self.assertEqual(j.counts()["queued"], 1)

    def test_files_are_private_and_state_holds_no_text(self) -> None:
        j = CaptureJournal(self.dir)
        j.append(_entry(0))
        j.reject()
        j.note_error("E_TIMEOUT")
        self.assertEqual(j.last_error(), "E_TIMEOUT")
        if os.name == "posix":
            self.assertEqual(os.stat(self.dir).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(j.path).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(j.state_path).st_mode & 0o777, 0o600)
        with open(j.state_path, encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["rejected"], 1)
        self.assertNotIn("turn", json.dumps(state))
        j.note_error(None)
        self.assertIsNone(j.last_error())




class JournalSharingTest(unittest.TestCase):
    """Windows: a file being replaced or deleted, or open in a reader without FILE_SHARE_DELETE, refuses opens,
    renames and unlinks for a moment (CI windows-2025: PermissionError in counts() during a drain rewrite)."""

    def setUp(self) -> None:
        self.dir = os.path.join(tempfile.mkdtemp(prefix="p1h-js-"), "plur1bus")
        self.addCleanup(shutil.rmtree, os.path.dirname(self.dir), ignore_errors=True)

    def _flaky_open(self, failures: int):
        """A stand-in for the journal's one read primitive that fails ``failures`` times first."""
        real_read = journal_mod._read_once
        left = [failures]

        def fake(path):
            if left[0] > 0:
                left[0] -= 1
                raise PermissionError(errno.EACCES, "Permission denied", str(path))
            return real_read(path)

        return fake, left

    def test_reads_retry_sharing_errors_on_windows(self) -> None:
        j = CaptureJournal(self.dir)
        j.append(_entry(0))
        j.reject()
        fake, left = self._flaky_open(4)
        with mock.patch.object(journal_mod, "_WINDOWS", True), mock.patch.object(journal_mod, "_read_once", fake):
            self.assertEqual(j.counts(), {"queued": 1, "dropped": 0, "rejected": 1, "lost": 0})
        self.assertEqual(left[0], 0, "the transient failures were retried, not swallowed")

    def test_readers_never_raise_and_writers_never_reset_counters_past_the_budget(self) -> None:
        j = CaptureJournal(self.dir)
        j.append(_entry(0))
        j.reject()
        fake, _ = self._flaky_open(10**9)
        with mock.patch.object(journal_mod, "_WINDOWS", True), mock.patch.object(journal_mod, "SHARING_RETRY_S", 0.05), mock.patch.object(
            journal_mod, "_read_once", fake
        ):
            with self.assertLogs("plur1bus", "INFO"):
                self.assertEqual(j.counts()["queued"], 0)  # status keeps working
            self.assertIsNone(j.last_error())
            with self.assertRaises(PermissionError):
                j.reject()  # a read-modify-write must not overwrite the counters with {}
        self.assertEqual(j.counts(), {"queued": 1, "dropped": 0, "rejected": 1, "lost": 0})

    def test_posix_permission_errors_are_not_retried(self) -> None:
        j = CaptureJournal(self.dir)
        j.append(_entry(0))
        fake, left = self._flaky_open(1)
        with mock.patch.object(journal_mod, "_WINDOWS", False), mock.patch.object(journal_mod, "_read_once", fake):
            with self.assertRaises(PermissionError):
                j._read_lines()
        self.assertEqual(left[0], 0)

    @unittest.skipUnless(os.name == "nt", "Windows sharing semantics")
    def test_reader_and_writers_race_on_windows(self) -> None:
        """Real Windows race: status pollers read while the writer appends, rewrites with os.replace (drain)
        and unlinks the emptied file. On Windows the shared-delete reader never blocks the writer; Wine refuses
        a replace over any open target, so there the writer's own retry (atomic_write_text) covers it."""
        j = CaptureJournal(self.dir)
        errors: list[BaseException] = []
        stop = threading.Event()

        def reader() -> None:
            while not stop.is_set():
                try:
                    j.counts()
                except BaseException as e:  # noqa: BLE001
                    errors.append(e)
                    return
                time.sleep(0.01)  # a status poller, not a busy loop

        readers = [threading.Thread(target=reader) for _ in range(2)]
        for t in readers:
            t.start()
        try:
            for i in range(30):
                for k in range(3):
                    j.append(_entry(i * 3 + k))
                j.drain(lambda e: None, batch=2)  # rewrites (os.replace) then unlinks the empty file
        finally:
            stop.set()
            for t in readers:
                t.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(j.counts()["queued"], 0)

    @unittest.skipUnless(os.name == "nt", "Windows delete-pending semantics")
    def test_delete_pending_journal_is_waited_out_on_windows(self) -> None:
        """Deterministic: another process's handle (FILE_SHARE_DELETE) keeps the unlinked journal
        delete-pending, so opens fail with access denied until it closes."""
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateFileW.restype = wintypes.HANDLE
        k32.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        j = CaptureJournal(self.dir)
        j.append(_entry(0))
        generic_read, share_all, open_existing = 0x80000000, 0x7, 3
        h = k32.CreateFileW(j.path, generic_read, share_all, None, open_existing, 0, None)
        self.assertNotIn(h, (None, wintypes.HANDLE(-1).value), ctypes.get_last_error())
        os.unlink(j.path)  # delete-pending while h is open
        try:
            with open(j.path, "rb"):
                pending = False
        except PermissionError:
            pending = True
        except FileNotFoundError:
            pending = False
        if not pending:
            k32.CloseHandle(h)
            self.skipTest("this platform (e.g. Wine) does not keep an unlinked open file delete-pending")
        threading.Timer(0.3, k32.CloseHandle, args=(h,)).start()
        start = time.monotonic()
        self.assertEqual(j.counts()["queued"], 0)
        j.append(_entry(1))  # O_CREAT on a delete-pending name is retried too
        self.assertEqual(j.counts()["queued"], 1)
        self.assertGreater(time.monotonic() - start, 0.2, "the read waited for the handle to close")


if __name__ == "__main__":
    unittest.main()
