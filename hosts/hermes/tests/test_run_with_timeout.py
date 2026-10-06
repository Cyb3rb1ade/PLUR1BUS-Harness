"""The watchdog runner itself: child interpreters run throwaway suites from a temp dir (never the real tests)."""
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_with_timeout.py")
HAS_ALARM = hasattr(__import__("signal"), "setitimer")

SUITE = textwrap.dedent(
    """
    import importlib.util, time, unittest
    spec = importlib.util.spec_from_file_location("rwt", {runner!r})
    rwt = importlib.util.module_from_spec(spec); spec.loader.exec_module(rwt)

    class T(unittest.TestCase):
        def test_a_fast(self):
            pass

        def test_b_hangs(self):
            try:
                time.sleep(60)
            except Exception:
                pass  # TestTimeout is a BaseException: this must not swallow it

        def test_c_after(self):
            pass

        @rwt.timeout(20)
        def test_d_declared_longer(self):
            time.sleep(1.5)

    class Wedged(unittest.TestCase):
        def test_swallows_everything(self):
            while True:
                try:
                    time.sleep(60)
                except BaseException:
                    pass
    """
)


class RunnerTest(unittest.TestCase):
    def _run(self, source: str, *, test_timeout: str = "1", pattern: str = "t_*.py", extra_env=None):
        tmp = tempfile.TemporaryDirectory(prefix="p1h-rwt-")
        self.addCleanup(tmp.cleanup)
        with open(os.path.join(tmp.name, "t_suite.py"), "w", encoding="utf-8") as handle:
            handle.write(source.format(runner=RUNNER) if "{runner!r}" in source else source)
        env = {k: v for k, v in os.environ.items() if not k.startswith("PLUR1BUS_TEST_")}
        env.update({"PLUR1BUS_TEST_TIMEOUT": test_timeout, "PLUR1BUS_TEST_BACKSTOP_GRACE": "1"})
        env.update(extra_env or {})
        return subprocess.run(
            [sys.executable, RUNNER, "discover", "-v", "-s", tmp.name, "-t", tmp.name, "-p", pattern],
            capture_output=True, text=True, timeout=60, env=env, cwd=tmp.name,
        )

    @unittest.skipUnless(HAS_ALARM, "POSIX SIGALRM path")
    def test_posix_hang_fails_that_test_and_the_run_continues(self) -> None:
        source = SUITE.replace("class Wedged(unittest.TestCase)", "class Wedged(object)")  # not collected in this run
        done = self._run(source)
        self.assertNotEqual(done.returncode, 0, done.stderr)
        self.assertIn("Ran 4 tests", done.stderr)
        self.assertIn("errors=1", done.stderr)
        self.assertIn("TIMEOUT after 1s in t_suite.T.test_b_hangs", done.stderr)
        self.assertIn("(most recent call first)", done.stderr)  # stacks of all threads
        self.assertRegex(done.stderr, r"test_c_after .*ok")
        self.assertRegex(done.stderr, r"test_d_declared_longer .*ok")  # 1.5 s > the 1 s default, within its own 20 s

    @unittest.skipIf(HAS_ALARM, "Windows watchdog-thread path")
    def test_windows_hang_dumps_stacks_and_exits_nonzero(self) -> None:
        done = self._run(SUITE.replace("class Wedged(unittest.TestCase)", "class Wedged(object)"))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("TIMEOUT after 1s in t_suite.T.test_b_hangs", done.stderr)
        self.assertIn("(most recent call first)", done.stderr)

    def test_a_test_that_swallows_the_timeout_is_killed_by_the_backstop(self) -> None:
        source = SUITE.replace("class T(unittest.TestCase)", "class T(object)")
        done = self._run(source)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("Timeout (", done.stderr)  # faulthandler's own dump
        self.assertIn("test_swallows_everything", done.stderr)

    def test_fast_suite_matches_plain_unittest(self) -> None:
        source = textwrap.dedent(
            """
            import unittest
            class T(unittest.TestCase):
                def test_one(self): pass
                def test_two(self): self.skipTest("x")
                def test_three(self):
                    with self.subTest(i=1): pass
            """
        )
        ours = self._run(source, test_timeout="30")
        with tempfile.TemporaryDirectory(prefix="p1h-rwt-") as tmp:
            with open(os.path.join(tmp, "t_suite.py"), "w", encoding="utf-8") as handle:
                handle.write(source)
            plain = subprocess.run(
                [sys.executable, "-m", "unittest", "discover", "-v", "-s", tmp, "-t", tmp, "-p", "t_*.py"],
                capture_output=True, text=True, timeout=60, cwd=tmp,
            )
        self.assertEqual(ours.returncode, plain.returncode)
        for text in (ours.stderr, plain.stderr):
            self.assertIn("Ran 3 tests", text)
            self.assertIn("OK (skipped=1)", text)

    def test_bad_env_value_is_rejected(self) -> None:
        done = self._run("import unittest\n", test_timeout="soon")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("PLUR1BUS_TEST_TIMEOUT", done.stderr)


if __name__ == "__main__":
    unittest.main()
