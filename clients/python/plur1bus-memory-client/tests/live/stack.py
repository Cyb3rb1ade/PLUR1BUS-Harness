"""A flat-embedder PLUR1BUS stack in a temp home for the live suites (HM2 Task 6).

Mirrors ``tests/system/helpers.ts``: ``plur1bus --home <tmp> daemon start`` with ``PLUR1BUS_CORE_JS``, this
machine's ``node`` as ``PLUR1BUS_NODE``, ``PLUR1BUS_ALLOW_TEST_INTERNALS=1`` plus
``PLUR1BUS_TEST_INTERNALS=flat-embedder`` (no model download) and ``engine.duplicateThreshold = 1.01`` (the flat
embedder gives every text the same vector; above 1 the duplicate check never matches). The service manager is
never touched: ``daemon start`` spawns the supervisor directly, and ``PLUR1BUS_SERVICE_FAKE`` answers the status
calls of ``daemon status`` and ``1staid check``.

This file is also loaded by ``hosts/hermes/tests/e2e`` (by path, it imports nothing from the test package).
Stdlib only.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

#: Every CLI call is killed after this long (and then fails the test).
CLI_TIMEOUT_S = 60.0
#: Models (the flat seam) warm within this after ``daemon start``.
WARM_TIMEOUT_S = 60.0
#: The recall hard budget the live suites use: shared CI runners are not reference hardware (H3-R26).
RECALL_HARD_MS = int(os.environ.get("PLUR1BUS_CI_RECALL_HARD_MS") or "3000")
FLAT_INTERNALS = os.environ.get("PLUR1BUS_SYSTEM_INTERNALS") or "flat-embedder"
#: ``supervisor.healthIntervalMs`` for the stack, or ``None`` for the default (5 s). Windows only, a documented wait
#: for an engine finding: the engine reads a shared store's directory ACL with a synchronous ``powershell.exe`` run
#: (lib/platform.js readDirectoryAcl, ``execFileSync``, 30 s timeout) that blocks the core's event loop, so no health
#: poll succeeds meanwhile. The supervisor calls a core hung after ``max(30 s, 3 x interval)`` without a successful
#: poll (ADR-012) and shuts it down: on windows-11-arm (HM2 CI round 2) the ``memory.share`` call returned after
#: about 30 s and every later call of the class, the next test's included, got ``E_CORE_UNAVAILABLE`` "core is
#: stopping". At 20 s the hang threshold is 60 s, above the worst case of one interval since the last poll, the 30 s
#: block and a 2 s poll deadline (52 s). Remove with the engine's asynchronous ACL read.
HEALTH_INTERVAL_MS: int | None = 20_000 if sys.platform == "win32" else None


def requirements() -> tuple[str, str]:
    """``(bin, core_js)`` from ``PLUR1BUS_BIN`` / ``PLUR1BUS_CORE_JS``; raises ``unittest.SkipTest`` (and prints the
    reason) when either is unset or missing."""
    bin_ = os.environ.get("PLUR1BUS_BIN") or ""
    core = os.environ.get("PLUR1BUS_CORE_JS") or ""
    reason = None
    if not bin_ or not core:
        reason = "live suite skipped: set PLUR1BUS_BIN (a built plur1bus) and PLUR1BUS_CORE_JS (packages/core/dist/core.js)"
    elif not os.path.isfile(bin_):
        reason = f"live suite skipped: PLUR1BUS_BIN={bin_} does not exist"
    elif not os.path.isfile(core):
        reason = f"live suite skipped: PLUR1BUS_CORE_JS={core} does not exist"
    elif not shutil.which("node"):
        reason = "live suite skipped: no node on PATH for the core"
    if reason:
        print(reason, file=sys.stderr)
        if os.environ.get("PLUR1BUS_LIVE_REQUIRED") == "1":
            # CI sets this after building the stack: a live suite that would skip is a failure there.
            raise AssertionError(reason.replace("skipped", "required (PLUR1BUS_LIVE_REQUIRED=1) but cannot run"))
        raise unittest.SkipTest(reason)
    return os.path.abspath(bin_), os.path.abspath(core)


class CliError(Exception):
    def __init__(self, argv: list[str], code: int, stdout: str, stderr: str) -> None:
        self.argv, self.code, self.stdout, self.stderr = argv, code, stdout, stderr
        try:
            self.doc = json.loads(stdout) if stdout.strip() else None
        except ValueError:
            self.doc = None
        super().__init__(f"{' '.join(argv[3:])}: exit {code}\n{stdout.strip()[-2000:]}\n{stderr.strip()[-2000:]}")


class LiveStack:
    """One temp PLUR1BUS home with a supervised core. ``start()`` creates ``agents`` before the core starts."""

    def __init__(self, agents: tuple[str, ...] = ("hermes-default",), *, prefix: str = "p1b-live-") -> None:
        self.bin, self.core_js = requirements()
        self.agents = agents
        # realpath: macOS hands out /var/... for /private/var/...; the core and the client must hash one string.
        self.home = os.path.realpath(tempfile.mkdtemp(prefix=prefix))
        # The recording fake answers even the read-only service status calls (never the real manager).
        self.service_fake = os.path.realpath(tempfile.mkdtemp(prefix="p1b-svc-"))
        self.env = dict(os.environ)
        for k in ("PLUR1BUS_HOME", "PLUR1BUS_NODE_MIRROR", "PLUR1BUS_CONTAINER"):
            self.env.pop(k, None)
        self.env.update(
            PLUR1BUS_CORE_JS=self.core_js,
            PLUR1BUS_NODE=shutil.which("node") or "node",
            PLUR1BUS_ALLOW_TEST_INTERNALS="1",
            PLUR1BUS_TEST_INTERNALS=FLAT_INTERNALS,
            PLUR1BUS_SERVICE_FAKE=self.service_fake,
        )

    # -- CLI -------------------------------------------------------------------------------------

    def cli(self, *args: str, json_out: bool = True, check: bool = True, timeout: float = CLI_TIMEOUT_S) -> object:
        argv = [self.bin, *(["--json"] if json_out else []), "--home", self.home, *args]
        proc = subprocess.run(
            argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, env=self.env, stdin=subprocess.DEVNULL,
        )
        if proc.returncode != 0:
            err = CliError(argv, proc.returncode, proc.stdout, proc.stderr)
            if check:
                raise err
            return err
        if not json_out:
            return proc.stdout
        return json.loads(proc.stdout)

    # -- lifecycle -------------------------------------------------------------------------------

    def start(self) -> LiveStack:
        """Create the agents, start the supervisor and wait for warm models; on any failure the home is cleaned
        up before the error propagates (a failed ``setUpClass`` gets no ``tearDownClass``)."""
        try:
            self._start()
        except BaseException:
            self.close()
            raise
        return self

    def _start(self) -> None:
        for agent in self.agents:
            self.cli("agent", "create", agent)
        self.cli("config", "set", "engine.duplicateThreshold", "1.01", "--yes")
        self.cli("config", "set", "core.recall.hardBudgetMs", str(RECALL_HARD_MS), "--yes")
        if HEALTH_INTERVAL_MS is not None:
            self.cli("config", "set", "supervisor.healthIntervalMs", str(HEALTH_INTERVAL_MS), "--yes")
        self.cli("daemon", "start")
        self.wait_warm()

    def restart(self) -> None:
        self.cli("daemon", "restart")
        self.wait_warm()

    def stop(self) -> None:
        self.cli("daemon", "stop")

    def start_again(self) -> None:
        self.cli("daemon", "start")
        self.wait_warm()

    def check(self, check_id: str) -> str | None:
        """The status of one ``1staid check`` row (exit 1 still prints the document)."""
        r = self.cli("1staid", "check", check=False)
        doc = r.doc if isinstance(r, CliError) else r
        for c in (doc or {}).get("checks", []):
            if c.get("id") == check_id:
                return c.get("status")
        return None

    def wait_warm(self, timeout: float = WARM_TIMEOUT_S) -> None:
        end = time.monotonic() + timeout
        last = None
        while time.monotonic() < end:
            last = self.check("models.warm")
            if last == "ok":
                return
            if last == "fail":
                break
            time.sleep(0.25)
        raise AssertionError(f"models not warm within {timeout} s (models.warm: {last})")

    def token(self) -> str:
        with open(os.path.join(self.home, "run", "core.token"), encoding="ascii") as f:
            return f.read().strip()

    def memories(self, agent: str) -> list[dict]:
        doc = self.cli("memory", "list", "--agent", agent)
        assert isinstance(doc, dict)
        return list(doc.get("items") or [])

    def close(self) -> None:
        """``daemon stop``; then kill whatever still runs against the home; then remove it."""
        pids: list[int] = []
        try:
            st = self.cli("daemon", "status", check=False)
            if isinstance(st, dict):
                sup = (st.get("supervisor") or {}).get("pid")
                pids = [p for p in [sup, *[(c or {}).get("pid") for c in st.get("children") or []]] if isinstance(p, int)]
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        try:
            self.cli("daemon", "stop", check=False)
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        if os.name == "posix":
            try:
                out = subprocess.run(["pgrep", "-f", "--", f"--home {self.home}"], capture_output=True, text=True, timeout=10).stdout
                pids += [int(p) for p in out.split()]
            except (OSError, subprocess.SubprocessError, ValueError):
                pass
            for pid in set(pids):
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
        else:
            for pid in set(pids):
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=30)
        for _ in range(20):  # Windows: files stay locked briefly after the processes exit
            shutil.rmtree(self.home, ignore_errors=True)
            if not os.path.exists(self.home):
                break
            time.sleep(0.25)
        shutil.rmtree(self.service_fake, ignore_errors=True)


def wait_until(what: str, probe, timeout: float, every: float = 0.1):
    end = time.monotonic() + timeout
    while True:
        v = probe()
        if v:
            return v
        if time.monotonic() > end:
            raise AssertionError(f"timed out after {timeout} s waiting for {what}")
        time.sleep(every)
