"""``PLUR1BUS_LIVE_REQUIRED=1`` turns a live suite's skip into a failure (CI sets it after building the stack)."""

from __future__ import annotations

import io
import os
import unittest
from contextlib import redirect_stderr
from unittest import mock

from tests.live import stack


class LiveRequiredTest(unittest.TestCase):
    def call(self, **env: str) -> None:
        clean = {k: v for k, v in os.environ.items() if k not in ("PLUR1BUS_BIN", "PLUR1BUS_CORE_JS", "PLUR1BUS_LIVE_REQUIRED")}
        clean.update(env)
        with mock.patch.dict(os.environ, clean, clear=True), redirect_stderr(io.StringIO()):
            stack.requirements()

    def test_missing_requirements_skip_without_the_flag(self) -> None:
        with self.assertRaises(unittest.SkipTest):
            self.call()
        with self.assertRaises(unittest.SkipTest):
            self.call(PLUR1BUS_LIVE_REQUIRED="0", PLUR1BUS_BIN="/nonexistent/plur1bus", PLUR1BUS_CORE_JS="/nonexistent/core.js")

    def test_missing_requirements_fail_with_the_flag(self) -> None:
        with self.assertRaises(AssertionError) as cm:
            self.call(PLUR1BUS_LIVE_REQUIRED="1")
        self.assertNotIsInstance(cm.exception, unittest.SkipTest)
        with self.assertRaises(AssertionError):
            self.call(PLUR1BUS_LIVE_REQUIRED="1", PLUR1BUS_BIN="/nonexistent/plur1bus", PLUR1BUS_CORE_JS="/nonexistent/core.js")


if __name__ == "__main__":
    unittest.main()
