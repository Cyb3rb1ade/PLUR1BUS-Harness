import errno
import os
import runpy
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from plur1bus import _filelock as lock_mod


class WindowsSharingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="p1h-lock-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.path = os.path.join(self.root, "lock")
        self.now = 0.0
        self.sleeps = []

    def _sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        self.now += delay

    def _error(self, code: int | None, error_type=PermissionError) -> OSError:
        error = error_type(errno.EACCES if error_type is PermissionError else errno.EBUSY, "not logged")
        error.winerror = code
        return error

    def _windows_clock(self):
        self.enterContext(mock.patch.object(lock_mod.os, "name", "nt"))
        self.enterContext(mock.patch.object(lock_mod.time, "monotonic", side_effect=lambda: self.now))
        self.enterContext(mock.patch.object(lock_mod.time, "sleep", side_effect=self._sleep))

    def test_open_retries_sharing_errors_then_acquires(self) -> None:
        real_open = os.open
        for error_type in (PermissionError, OSError):
            for code in (None, 5, 32, 33):
                with self.subTest(error_type=error_type, code=code):
                    self.now, self.sleeps = 0.0, []
                    calls = 0

                    def busy_twice(*args):
                        nonlocal calls
                        calls += 1
                        if calls <= 2:
                            raise self._error(code, error_type)
                        return real_open(*args)

                    with mock.patch.object(lock_mod.os, "name", "nt"), \
                         mock.patch.object(lock_mod.time, "monotonic", side_effect=lambda: self.now), \
                         mock.patch.object(lock_mod.time, "sleep", side_effect=self._sleep), \
                         mock.patch.object(lock_mod.os, "open", side_effect=busy_twice) as opened:
                        with lock_mod.ExclusiveLockFile(self.path).hold(0.1) as held:
                            held.verify()
                        self.assertEqual(opened.call_count, 3)
                    self.assertFalse(os.path.exists(self.path))

    def test_persistent_open_error_stops_at_deadline(self) -> None:
        self._windows_clock()
        calls = []

        def busy(*args):
            calls.append(self.now)
            raise self._error(32)

        with mock.patch.object(lock_mod.os, "open", side_effect=busy):
            with self.assertRaises(lock_mod.LockTimeout):
                with lock_mod.ExclusiveLockFile(self.path).hold(0.012):
                    self.fail("entered a busy lock")
        self.assertLessEqual(self.now, 0.012)
        self.assertTrue(all(t < 0.012 for t in calls), calls)
        self.assertFalse(os.path.exists(self.path))

    def test_stale_rename_retries_then_acquires(self) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("old lock")
        os.utime(self.path, (0, 0))
        real_rename = os.rename
        self._windows_clock()
        calls = 0

        def busy_twice(src, dst):
            nonlocal calls
            calls += 1
            if calls <= 2:
                raise self._error(33)
            return real_rename(src, dst)

        with mock.patch.object(lock_mod.os, "rename", side_effect=busy_twice):
            with lock_mod.ExclusiveLockFile(self.path).hold(0.1) as held:
                held.verify()
        self.assertEqual(calls, 4)  # two refusals, stale break, release
        self.assertEqual(os.listdir(self.root), [])

    def test_stale_unlink_sharing_error_is_bounded_by_hold_deadline(self) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("old lock")
        os.utime(self.path, (0, 0))
        self._windows_clock()
        with mock.patch.object(lock_mod.os, "unlink", side_effect=self._error(32)):
            with self.assertRaises(lock_mod.LockTimeout):
                with lock_mod.ExclusiveLockFile(self.path).hold(0.012):
                    self.fail("acquired after cleanup exhausted the deadline")
        self.assertLessEqual(self.now, 0.012)

    def test_persistent_stale_rename_error_stops_at_deadline(self) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("old lock")
        os.utime(self.path, (0, 0))
        self._windows_clock()
        with mock.patch.object(lock_mod.os, "rename", side_effect=self._error(32)) as renamed:
            with self.assertRaises(lock_mod.LockTimeout):
                with lock_mod.ExclusiveLockFile(self.path).hold(0.012):
                    self.fail("entered a lock that could not be broken")
        renamed.assert_called_once()
        self.assertLessEqual(self.now, 0.012)
        self.assertTrue(os.path.exists(self.path))

    def test_retry_helper_never_retries_after_budget(self) -> None:
        self._windows_clock()
        calls = []

        def busy():
            calls.append(self.now)
            raise self._error(5, OSError)

        with self.assertRaises(OSError):
            lock_mod._retry_sharing(busy, 0.012)
        self.assertGreater(len(calls), 1)
        self.assertLessEqual(self.now, 0.012)
        self.assertTrue(all(t < 0.012 for t in calls), calls)

    def test_sweep_sharing_error_cannot_extend_acquisition_deadline(self) -> None:
        for suffix in (".break-old", ".rel-old"):
            with open(self.path + suffix, "w", encoding="utf-8") as f:
                f.write("old lock")
            os.utime(self.path + suffix, (0, 0))
        self._windows_clock()
        with mock.patch.object(lock_mod.os, "unlink", side_effect=self._error(32)), \
             mock.patch.object(lock_mod.os, "open") as opened:
            with self.assertRaises(lock_mod.LockTimeout):
                with lock_mod.ExclusiveLockFile(self.path).hold(0.012):
                    self.fail("acquired after sweep exhausted the deadline")
        opened.assert_not_called()
        self.assertLessEqual(self.now, 0.012)

    def test_zero_timeout_still_allows_one_create_attempt(self) -> None:
        self._windows_clock()
        with lock_mod.ExclusiveLockFile(self.path).hold(0) as held:
            held.verify()
        with mock.patch.object(lock_mod.os, "open", side_effect=self._error(32)) as opened:
            with self.assertRaises(lock_mod.LockTimeout):
                with lock_mod.ExclusiveLockFile(self.path).hold(0):
                    self.fail("entered a busy lock")
        opened.assert_called_once()
        self.assertEqual(self.sleeps, [])

    def test_posix_permission_error_is_not_retried(self) -> None:
        with mock.patch.object(lock_mod.os, "name", "posix"), \
             mock.patch.object(lock_mod.os, "open", side_effect=self._error(32)) as opened, \
             mock.patch.object(lock_mod.time, "sleep") as sleep:
            with self.assertRaises(PermissionError):
                with lock_mod.ExclusiveLockFile(self.path).hold(1):
                    self.fail("entered a denied lock")
        opened.assert_called_once()
        sleep.assert_not_called()

    def test_nonsharing_windows_error_is_not_retried(self) -> None:
        self._windows_clock()
        for error in (OSError(errno.EIO, "not logged"), self._error(87)):
            with self.subTest(error=type(error).__name__), \
                 mock.patch.object(lock_mod.os, "open", side_effect=error) as opened:
                with self.assertRaises(OSError):
                    with lock_mod.ExclusiveLockFile(self.path).hold(1):
                        self.fail("entered a broken lock")
            opened.assert_called_once()
        self.assertEqual(self.sleeps, [])

    def test_worker_logs_only_exception_class_and_numeric_code(self) -> None:
        real_open = os.open
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_lock_worker.py")
        log = os.path.join(self.root, "worker.log")
        for code in (None, 32):
            with self.subTest(winerror=code):
                error = PermissionError(errno.EACCES, "private message", self.path)
                if code is not None:
                    error.winerror = code

                def failed_lock(path, *args):
                    if path == self.path:
                        raise error
                    return real_open(path, *args)

                with mock.patch.object(os, "name", "posix"), \
                     mock.patch.object(os, "open", side_effect=failed_lock), \
                     mock.patch.object(sys, "argv", [worker, self.path, log, "1", "-1"]), \
                     mock.patch.dict(sys.modules):
                    runpy.run_path(worker, run_name="__main__")
                with open(log, encoding="utf-8") as f:
                    self.assertEqual(f.read(), f"T {os.getpid()} PermissionError {code or errno.EACCES}\n")
                os.unlink(log)
