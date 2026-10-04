"""Guarded atomic_write_text (FR-L1 option ii): before_replace runs after fsync/close
and before every os.replace, including Windows sharing retries. Unguarded callers stay
as they were."""

from __future__ import annotations

import errno
import os
import shutil
import tempfile
import unittest
from unittest import mock

from plur1bus import binding as binding_mod
from plur1bus.binding import atomic_write_text


def _tmp_left(directory: str) -> list[str]:
    return [n for n in os.listdir(directory) if ".tmp-" in n]


class AtomicWriteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="p1h-aw-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.now = 0.0

    def _sleep(self, delay: float) -> None:
        self.now += delay

    def _sharing(self, winerror: int = 32) -> PermissionError:
        error = PermissionError(errno.EACCES, "sharing")
        error.winerror = winerror
        return error

    def _windows_retry(self):
        self.enterContext(mock.patch.object(binding_mod.os, "name", "nt"))
        self.enterContext(mock.patch.object(binding_mod.time, "monotonic", side_effect=lambda: self.now))
        self.enterContext(mock.patch.object(binding_mod.time, "sleep", side_effect=self._sleep))

    def test_before_replace_raises_leaves_target_and_deletes_tmp(self) -> None:
        path = os.path.join(self.root, "target.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write("original\n")
        err = RuntimeError("verify failed")

        def boom() -> None:
            raise err

        with self.assertRaises(RuntimeError) as cm:
            atomic_write_text(path, "new\n", before_replace=boom)
        self.assertIs(cm.exception, err)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "original\n")
        self.assertEqual(_tmp_left(self.root), [])

    def test_before_replace_runs_before_every_windows_retry(self) -> None:
        path = os.path.join(self.root, "target.txt")
        verifies: list[str] = []
        attempts = 0
        real_replace = os.replace

        def busy_twice(src: str, dst: str) -> None:
            nonlocal attempts
            attempts += 1
            if attempts <= 2:
                raise self._sharing(32)
            real_replace(src, dst)

        self._windows_retry()
        with mock.patch.object(binding_mod.os, "replace", side_effect=busy_twice):
            atomic_write_text(path, "ok\n", before_replace=lambda: verifies.append("verify"))
        self.assertEqual(attempts, 3)
        self.assertEqual(len(verifies), 3, "verify ran before each replace, including retries")
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "ok\n")
        self.assertEqual(_tmp_left(self.root), [])

    def test_before_replace_refuse_on_second_windows_attempt_deletes_tmp(self) -> None:
        path = os.path.join(self.root, "target.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write("keep\n")
        verifies = 0
        lost = RuntimeError("lock-lost")

        def boom_on_second() -> None:
            nonlocal verifies
            verifies += 1
            if verifies == 2:
                raise lost

        def always_busy(_src: str, _dst: str) -> None:
            raise self._sharing(32)

        self._windows_retry()
        with mock.patch.object(binding_mod.os, "replace", side_effect=always_busy):
            with self.assertRaises(RuntimeError) as cm:
                atomic_write_text(path, "new\n", before_replace=boom_on_second)
            self.assertIs(cm.exception, lost)
        self.assertEqual(verifies, 2)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "keep\n")
        self.assertEqual(_tmp_left(self.root), [])

    def test_unguarded_write_still_replaces_the_target(self) -> None:
        path = os.path.join(self.root, "target.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write("old\n")
        atomic_write_text(path, "new\n")
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "new\n")
        self.assertEqual(_tmp_left(self.root), [])
