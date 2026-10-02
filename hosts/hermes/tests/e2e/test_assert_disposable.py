"""``assert_disposable.py`` (HM2 Task 6): a real Hermes is only ever touched under the disposable root."""

from __future__ import annotations

import io
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

import assert_disposable as ad


class AssertDisposableTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="p1b-rt-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.env = {"RUNNER_TEMP": self.root}

    def run_main(self, env: dict, *paths: str) -> tuple[int, str]:
        err = io.StringIO()
        argv = [a for p in paths for a in ("--path", p)]
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = ad.main(argv, env)
        return code, err.getvalue()

    def test_paths_inside_runner_temp_pass(self) -> None:
        env = dict(self.env, HERMES_HOME=os.path.join(self.root, "fakehome", ".hermes"))
        self.assertEqual(self.run_main(env, os.path.join(self.root, "hermes-agent"), os.path.join(self.root, "p1b")), (0, ""))

    def test_refuses_a_hermes_home_outside_runner_temp_or_the_temp_dir(self) -> None:
        outside = os.path.realpath(tempfile.mkdtemp(prefix="p1b-out-", dir=os.path.dirname(self.root)))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        code, err = self.run_main(dict(self.env, HERMES_HOME=outside))
        self.assertEqual(code, 2)
        self.assertIn("REFUSED", err)
        # Without RUNNER_TEMP the system temp dir is the root: a home directory is not inside it.
        code, _ = self.run_main({"HERMES_HOME": os.path.expanduser("~/.hermes")})
        self.assertEqual(code, 2)
        # ...and a temp dir is.
        self.assertEqual(self.run_main({"HERMES_HOME": os.path.join(self.root, "h")})[0], 0)

    def test_refuses_the_root_itself_an_unset_home_and_escapes(self) -> None:
        self.assertEqual(self.run_main(dict(self.env, HERMES_HOME=self.root))[0], 2)
        self.assertEqual(self.run_main(dict(self.env))[0], 2)
        self.assertEqual(self.run_main(dict(self.env, HERMES_HOME=os.path.join(self.root, "h", "..", "..")))[0], 2)
        env = dict(self.env, HERMES_HOME=os.path.join(self.root, "h"))
        self.assertEqual(self.run_main(env, os.path.dirname(self.root))[0], 2, "an extra --path outside is refused too")

    @unittest.skipUnless(hasattr(os, "symlink") and os.name == "posix", "symlinks: POSIX")
    def test_a_symlink_out_of_the_root_is_refused(self) -> None:
        outside = os.path.realpath(tempfile.mkdtemp(prefix="p1b-out-", dir=os.path.dirname(self.root)))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        link = os.path.join(self.root, "link")
        os.symlink(outside, link)
        self.assertEqual(self.run_main(dict(self.env, HERMES_HOME=link))[0], 2)

    def test_a_real_user_path_is_refused_even_inside_the_root(self) -> None:
        fake_real_home = os.path.join(self.root, "realhome")
        with self.assertRaises(ad.NotDisposable):
            ad.check([os.path.join(fake_real_home, ".hermes")], self.env, real_home=fake_real_home)
        with self.assertRaises(ad.NotDisposable):
            ad.check([self.root + os.sep + "x", fake_real_home], self.env, real_home=fake_real_home)
        localappdata = os.path.join(self.root, "lad")
        with self.assertRaises(ad.NotDisposable):
            ad.check([os.path.join(localappdata, "hermes")], dict(self.env, LOCALAPPDATA=localappdata))
        self.assertEqual(ad.check([os.path.join(fake_real_home, "other")], self.env, real_home=fake_real_home), os.path.normcase(self.root))


if __name__ == "__main__":
    unittest.main()
