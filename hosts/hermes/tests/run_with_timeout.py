"""unittest entry point with a per-test watchdog (dependency-free; Python 3.11+).

Drop-in for ``python -m unittest``: every argument is passed through, so
``python run_with_timeout.py discover -v -s <dir> -t <top>`` discovers exactly what
``python -m unittest discover -v -s <dir> -t <top>`` does.

A hung test (a lock that never frees, an RPC against a core that never answers) used to hold the CI job
until its step timeout, with no clue which test it was. Now:

* every test gets a deadline (default 120 s, ``PLUR1BUS_TEST_TIMEOUT`` seconds to change it);
* the stretch between tests (setUpClass/tearDownClass/module fixtures, loading) gets
  ``PLUR1BUS_FIXTURE_TIMEOUT`` seconds (default 300);
* on expiry every thread's stack is dumped to stderr and the test id is named;
* POSIX: SIGALRM (``setitimer``) raises ``TestTimeout`` in the main thread, so the test is reported as an error and the
  run continues; Windows (no SIGALRM): a watchdog thread prints the id plus the stacks and ``os._exit(1)``;
* backstop on both: ``faulthandler.dump_traceback_later(limit + 30, exit=True)`` (grace: ``PLUR1BUS_TEST_BACKSTOP_GRACE``) fires from C even when the
  interpreter is wedged (e.g. a C call holding the GIL, or a test that swallows ``TestTimeout``).

A test that legitimately needs longer opts in with ``@timeout(seconds)`` on the method or the class (the larger of
the decorated and the default value wins: lowering ``PLUR1BUS_TEST_TIMEOUT`` never shrinks a declared limit). No test needs it today: the slowest test in recent green CI runs takes about 12 s.
"""
from __future__ import annotations

import faulthandler
import os
import signal
import sys
import threading
import time
import unittest

DEFAULT_TIMEOUT = 120.0
DEFAULT_FIXTURE_TIMEOUT = 300.0
BACKSTOP_GRACE = 30.0
_ATTR = "_p1b_test_timeout"
_HAS_ALARM = hasattr(signal, "setitimer") and hasattr(signal, "SIGALRM")


class TestTimeout(BaseException):
    """BaseException so a test's ``except Exception`` cannot swallow the deadline."""

    __test__ = False


def timeout(seconds: float):
    """Raise the per-test limit of a method or TestCase class to ``seconds``."""

    def mark(obj):
        setattr(obj, _ATTR, float(seconds))
        return obj

    return mark


def _env_seconds(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        sys.exit(f"run_with_timeout: {name}={raw!r} is not a number")
    if value <= 0:
        sys.exit(f"run_with_timeout: {name} must be > 0")
    return value


def limit_for(test: unittest.TestCase, default: float) -> float:
    method = getattr(test, getattr(test, "_testMethodName", ""), None)
    declared = [getattr(method, _ATTR, None), getattr(type(test), _ATTR, None)]
    return max([default] + [d for d in declared if d is not None])


class Watchdog:
    """One re-armable deadline; at most one is live at a time (tests run serially)."""

    def __init__(self) -> None:
        self._generation = 0
        self._timer: threading.Thread | None = None
        self._cancel = threading.Event()
        self._label = ""
        self._limit = 0.0
        self._lock = threading.Lock()
        if _HAS_ALARM:
            signal.signal(signal.SIGALRM, self._on_alarm)

    def arm(self, label: str, limit: float) -> None:
        self.disarm()
        self._label, self._limit = label, limit
        # C-level backstop: survives a wedged interpreter, always exits non-zero.
        faulthandler.dump_traceback_later(limit + _BACKSTOP_GRACE, exit=True)
        if _HAS_ALARM:
            signal.setitimer(signal.ITIMER_REAL, limit)
        else:
            with self._lock:
                self._generation += 1
                generation = self._generation
            self._cancel = threading.Event()
            self._timer = threading.Thread(
                target=self._watch, args=(generation, self._cancel, label, limit), name="p1b-test-watchdog", daemon=True
            )
            self._timer.start()

    def disarm(self) -> None:
        faulthandler.cancel_dump_traceback_later()
        if _HAS_ALARM:
            signal.setitimer(signal.ITIMER_REAL, 0)
        else:
            self._cancel.set()
            self._timer = None

    def _report(self, label: str, limit: float) -> None:
        sys.stderr.write(f"\nrun_with_timeout: TIMEOUT after {limit:g}s in {label}\nall thread stacks follow:\n")
        sys.stderr.flush()
        faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
        sys.stderr.flush()

    def _on_alarm(self, _signum, _frame) -> None:
        self._report(self._label, self._limit)
        raise TestTimeout(f"{self._label} exceeded {self._limit:g}s (stacks dumped to stderr)")

    def _watch(self, generation: int, cancel: threading.Event, label: str, limit: float) -> None:
        if cancel.wait(limit):
            return
        with self._lock:
            if generation != self._generation:
                return
        self._report(label, limit)
        sys.stderr.write("run_with_timeout: Windows watchdog exits the run (no SIGALRM here)\n")
        sys.stderr.flush()
        os._exit(1)


_WATCHDOG: Watchdog | None = None
_TEST_DEFAULT = DEFAULT_TIMEOUT
_FIXTURE_LIMIT = DEFAULT_FIXTURE_TIMEOUT
_BACKSTOP_GRACE = BACKSTOP_GRACE


class WatchdogResult(unittest.TextTestResult):
    def startTest(self, test) -> None:
        super().startTest(test)
        assert _WATCHDOG is not None
        _WATCHDOG.arm(test.id(), limit_for(test, _TEST_DEFAULT))

    def stopTest(self, test) -> None:
        assert _WATCHDOG is not None
        # Covers whatever runs before the next test starts (class/module fixtures).
        _WATCHDOG.arm(f"fixture or runner step after {test.id()}", _FIXTURE_LIMIT)
        super().stopTest(test)


class WatchdogRunner(unittest.TextTestRunner):
    def __init__(self, *args, **kwargs) -> None:
        kwargs["resultclass"] = WatchdogResult
        super().__init__(*args, **kwargs)

    def run(self, test):
        try:
            return super().run(test)
        finally:
            if _WATCHDOG is not None:
                _WATCHDOG.disarm()


def main(argv: list[str]) -> None:
    global _WATCHDOG, _TEST_DEFAULT, _FIXTURE_LIMIT, _BACKSTOP_GRACE
    # `python path/to/run_with_timeout.py` puts this directory first on sys.path; `python -m unittest` would not.
    # Drop it so discovery imports exactly the modules it would under `-m unittest`.
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.getcwd()) != here]
    faulthandler.enable(file=sys.stderr, all_threads=True)
    _TEST_DEFAULT = _env_seconds("PLUR1BUS_TEST_TIMEOUT", DEFAULT_TIMEOUT)
    _FIXTURE_LIMIT = _env_seconds("PLUR1BUS_FIXTURE_TIMEOUT", DEFAULT_FIXTURE_TIMEOUT)
    _BACKSTOP_GRACE = _env_seconds("PLUR1BUS_TEST_BACKSTOP_GRACE", BACKSTOP_GRACE)
    _WATCHDOG = Watchdog()
    # Loading/discovery is covered by the fixture window too.
    _WATCHDOG.arm("test discovery", _FIXTURE_LIMIT)
    started = time.monotonic()
    try:
        unittest.main(module=None, argv=["run_with_timeout", *argv], testRunner=WatchdogRunner)
    finally:
        _WATCHDOG.disarm()
        sys.stderr.write(f"run_with_timeout: finished in {time.monotonic() - started:.1f}s\n")


if __name__ == "__main__":
    main(sys.argv[1:])
