import logging
import os
import shutil
import sys
import tempfile
import threading
import time
import traceback
import unittest

from tests.fakes import DROP, SILENT, FakeCore, FakeCoreProcess, default_capabilities

from plur1bus_memory_client import Caller, MemoryClient, RpcError

CALLER = Caller("hermes:cli", "local")


@unittest.skipIf(sys.platform == "win32" or not hasattr(__import__("socket"), "AF_UNIX"), "POSIX transport")
class ClientPosixTest(unittest.TestCase):
    def setUp(self) -> None:
        # Short paths: AF_UNIX addresses are limited to ~104 bytes.
        self.home = tempfile.mkdtemp(prefix="p1b-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.clients: list[MemoryClient] = []

    def tearDown(self) -> None:
        for c in self.clients:
            c.close()

    def client(self, **kw: object) -> MemoryClient:
        c = MemoryClient(self.home, **kw)  # type: ignore[arg-type]
        self.clients.append(c)
        return c

    def fake(self, **kw: object) -> FakeCore:
        core = FakeCore(self.home, **kw).start()  # type: ignore[arg-type]
        self.addCleanup(core.stop)
        return core

    # -- Review Focus 2: squatted or stale endpoints ---------------------------------------------------

    def test_token_is_not_sent_when_the_peer_pid_differs_from_core_pid(self) -> None:
        core = self.fake(pid=os.getpid() + 100000)  # run/core.pid names another process
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual(cm.exception.code, "E_SERVER_IDENTITY")
        self.assertEqual(cm.exception.reason, "server-pid-mismatch")
        time.sleep(0.05)
        self.assertNotIn("core.auth", core.methods())
        self.assertEqual(core.calls, [], "nothing at all was sent")
        self.assertNotIn(core.token, str(cm.exception))

    def test_a_malformed_pid_file_is_refused_before_the_token_is_sent(self) -> None:
        core = self.fake()
        with open(os.path.join(self.home, "run", "core.pid"), "w") as f:
            f.write("")
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual(cm.exception.code, "E_SERVER_IDENTITY")
        self.assertEqual(core.calls, [])

    def test_run_dir_writable_by_others_is_refused(self) -> None:
        core = self.fake()
        os.chmod(os.path.join(self.home, "run"), 0o777)
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual(cm.exception.code, "E_UNAUTHORIZED")
        self.assertEqual(cm.exception.reason, "run-dir-untrusted")
        self.assertEqual(cm.exception.data["legacy_code"], "E_SERVER_IDENTITY")
        self.assertEqual(core.connections, 0)

    def test_a_group_writable_run_dir_is_refused(self) -> None:
        self.fake()
        os.chmod(os.path.join(self.home, "run"), 0o770)
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_UNAUTHORIZED", "run-dir-untrusted"))

    def test_a_symlinked_run_dir_is_refused(self) -> None:
        core = self.fake()
        real = os.path.join(self.home, "real-run")
        os.rename(core.run, real)
        os.symlink(real, core.run)
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_UNAUTHORIZED", "run-dir-untrusted"))
        self.assertIn("symlink", cm.exception.data["detail"])
        self.assertEqual(core.connections, 0)

    # -- Review Focus 1: restarts ------------------------------------------------------------------------

    def test_token_is_reread_after_a_core_restart(self) -> None:
        proc = FakeCoreProcess(self.home).start()
        self.addCleanup(proc.stop)
        c = self.client()
        first = c.connect()
        self.assertEqual(first["pid"], proc.pid)
        old_token, old_pid = proc.token, proc.pid
        self.assertIn("joined", c.recall(CALLER, "hermes-default", "roadmap"))
        proc.restart()  # new process: new token, new pid, new run/core.pid
        self.assertNotEqual(proc.token, old_token)
        self.assertNotEqual(proc.pid, old_pid)
        self.assertIn("joined", c.recall(CALLER, "hermes-default", "roadmap"))
        self.assertEqual(c.hello["pid"], proc.pid)
        self.assertEqual(proc.methods(), ["core.auth", "memory.recall", "core.auth", "memory.recall"])

    def test_capture_after_a_restart_uses_a_fresh_connection(self) -> None:
        core = self.fake()
        c = self.client()
        c.connect()
        core.restart()
        c.capture(CALLER, "hermes-default", [{"role": "user", "content": "hello"}])
        self.assertEqual(core.methods().count("memory.capture"), 1)

    def test_capture_is_never_retried_automatically(self) -> None:
        core = self.fake(handlers={"memory.capture": DROP})
        c = self.client()
        with self.assertRaises(RpcError) as cm:
            c.capture(CALLER, "hermes-default", [{"role": "user", "content": "a synthetic turn"}])
        self.assertEqual(cm.exception.code, "E_TRANSPORT")
        self.assertEqual(core.methods().count("memory.capture"), 1)
        self.assertNotIn("synthetic", str(cm.exception))

    def test_forget_correct_share_checkpoint_are_never_retried(self) -> None:
        core = self.fake(handlers={m: DROP for m in ("memory.forget", "memory.correct", "memory.share", "memory.checkpoint")})
        c = self.client()
        calls = {
            "memory.forget": lambda: c.memory_forget(CALLER, "a", "m1"),
            "memory.correct": lambda: c.memory_correct(CALLER, "a", "m1", "fixed"),
            "memory.share": lambda: c.memory_share(CALLER, "a", "m1", "user"),
            "memory.checkpoint": lambda: c.checkpoint(CALLER, "a", "compaction"),
        }
        for method, call in calls.items():
            with self.subTest(method=method), self.assertRaises(RpcError) as cm:
                call()
            self.assertEqual(cm.exception.code, "E_TRANSPORT")
            self.assertEqual(core.methods().count(method), 1)

    def test_recall_reconnects_once_then_raises_core_unavailable(self) -> None:
        core = self.fake(handlers={"memory.recall": DROP})
        c = self.client()
        with self.assertRaises(RpcError) as cm:
            c.recall(CALLER, "hermes-default", "anything")
        self.assertEqual(cm.exception.code, "E_CORE_UNAVAILABLE")
        self.assertEqual(core.methods(), ["core.auth", "memory.recall", "core.auth", "memory.recall"])

    def test_recall_retry_succeeds_when_the_second_attempt_answers(self) -> None:
        answers = iter([DROP])

        def flaky(_params: dict) -> object:
            return next(answers, {"blocks": [], "capChars": 1, "degraded": None, "timing": {"totalMs": 1}, "deferrals": []})

        core = self.fake(handlers={"memory.recall": flaky})
        self.assertEqual(self.client().recall(CALLER, "a", "q")["deferrals"], [])
        self.assertEqual(core.methods().count("memory.recall"), 2)

    def test_a_stopped_core_is_core_unavailable(self) -> None:
        core = self.fake()
        core.stop()
        with self.assertRaises(RpcError) as cm:
            self.client().status()
        self.assertEqual(cm.exception.code, "E_CORE_UNAVAILABLE")

    def test_a_missing_token_is_core_unavailable(self) -> None:
        self.fake()
        os.unlink(os.path.join(self.home, "run", "core.token"))
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_CORE_UNAVAILABLE", "token-missing"))

    # -- deadlines (F14) -------------------------------------------------------------------------------

    def test_call_deadline_raises_timeout_within_budget(self) -> None:
        self.fake(handlers={"core.status": SILENT})
        c = self.client(call_timeout=0.5)
        c.connect()
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            c.status()
        elapsed = time.monotonic() - t0
        self.assertEqual(cm.exception.code, "E_TIMEOUT")
        self.assertLess(elapsed, 0.5 + 0.25)
        self.assertGreaterEqual(elapsed, 0.45)

    def test_a_connection_is_not_reused_after_a_timeout(self) -> None:
        state = {"silent": True}
        core = self.fake(handlers={"core.status": lambda _p: SILENT if state["silent"] else {"ok": 1}})
        c = self.client(call_timeout=0.3)
        with self.assertRaises(RpcError):
            c.status()
        state["silent"] = False
        self.assertEqual(c.status(), {"ok": 1})
        self.assertEqual(core.connections, 2)

    def test_recall_total_time_is_bounded_when_the_core_is_down(self) -> None:
        # The first attempt is dropped; the reconnect meets a core that accepts but never answers core.auth.
        core = self.fake()
        c = self.client(connect_timeout=2.0, call_timeout=5.0)
        c.connect()
        core.handlers["memory.recall"] = DROP
        core.handlers["core.auth"] = SILENT
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            c.recall(CALLER, "a", "q", deadline_s=0.8)
        elapsed = time.monotonic() - t0
        self.assertEqual(cm.exception.code, "E_TIMEOUT")
        self.assertLess(elapsed, 0.8 + 0.25)

    def test_recall_deadline_defaults_to_hard_ms_plus_400(self) -> None:
        self.fake(handlers={"memory.recall": SILENT})
        c = self.client(call_timeout=5.0)
        c.connect()
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            c.recall(CALLER, "a", "q", hard_ms=100)
        self.assertEqual(cm.exception.code, "E_TIMEOUT")
        self.assertLess(time.monotonic() - t0, 0.5 + 0.25)

    def test_connect_on_a_silent_core_is_bounded_by_connect_timeout(self) -> None:
        self.fake(handlers={"core.auth": SILENT})
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            self.client(connect_timeout=0.3).connect()
        self.assertEqual(cm.exception.code, "E_TIMEOUT")
        self.assertLess(time.monotonic() - t0, 0.3 + 0.25)

    # -- capabilities and versions ---------------------------------------------------------------------

    def test_supports_reads_core_auth_capabilities(self) -> None:
        caps = default_capabilities()
        caps["methods"]["memory.checkpoint"] = {"stability": "experimental", "since": "1.0.0"}
        self.fake(capabilities=caps)
        c = self.client()
        self.assertFalse(c.supports("memory.recall"), "nothing is known before a connect")
        c.connect()
        self.assertTrue(c.supports("memory.recall"))
        self.assertTrue(c.supports("memory.checkpoint"))
        self.assertFalse(c.supports("memory.share"))

    def test_rpc_major_2_is_refused(self) -> None:
        core = self.fake(rpc="2.0.0")
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_RPC_VERSION", "rpc-major"))
        self.assertEqual(core.methods(), ["core.auth"], "nothing else is called")

    def test_rpc_minor_below_3_is_refused_and_later_minors_accepted(self) -> None:
        core = self.fake(rpc="1.2.9")
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_RPC_VERSION", "rpc-minor"))
        for rpc in ("1.3.0", "1.4.0", "1.99.0"):
            core.rpc = rpc
            with self.subTest(rpc=rpc):
                self.assertEqual(self.client().connect()["rpc"], rpc)

    def test_a_wrong_token_is_unauthorized_and_the_error_carries_no_token(self) -> None:
        core = self.fake()
        with open(os.path.join(self.home, "run", "core.token"), "w") as f:
            f.write("ab" * 32)
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual(cm.exception.code, "E_UNAUTHORIZED")
        self.assertNotIn("ab" * 32, str(cm.exception) + repr(cm.exception) + repr(cm.exception.data))
        self.assertNotIn(core.token, str(cm.exception))

    # -- hygiene and concurrency -----------------------------------------------------------------------

    def test_the_token_never_reaches_a_log_record_or_repr(self) -> None:
        core = self.fake(handlers={"memory.capture": DROP})
        records: list[logging.LogRecord] = []

        class Keep(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        root = logging.getLogger()
        h = Keep(level=logging.DEBUG)
        old = root.level
        root.addHandler(h)
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.removeHandler, h)
        self.addCleanup(root.setLevel, old)
        c = self.client()
        c.connect()
        with self.assertRaises(RpcError) as cm:
            c.capture(CALLER, "a", [{"role": "user", "content": "private synthetic text"}])
        text = " ".join(r.getMessage() for r in records) + repr(c) + str(c.hello) + str(cm.exception)
        self.assertNotIn(core.token, text)
        self.assertNotIn("private synthetic text", text)

    def test_concurrent_calls_are_serialised_on_one_connection(self) -> None:
        core = self.fake()
        c = self.client()
        errors: list[BaseException] = []

        def work(i: int) -> None:
            try:
                for _ in range(10):
                    c.recall(CALLER, "a", f"q{i}")
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=work, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(core.methods().count("memory.recall"), 40)
        self.assertEqual(core.connections, 1)

    def test_a_long_recall_query_keeps_its_last_32000_characters(self) -> None:
        core = self.fake()
        query = "a" * 40000 + "tail"
        self.client().recall(CALLER, "a", query)
        sent = [p for m, p in core.calls if m == "memory.recall"][0]["query"]
        self.assertEqual(len(sent), 32000)
        self.assertTrue(sent.endswith("tail"))

    # -- review fixes -----------------------------------------------------------------------------------

    def test_the_token_is_read_only_after_the_s11_check(self) -> None:
        self.fake(pid=os.getpid() + 100000)
        with open(os.path.join(self.home, "run", "core.token"), "w") as f:
            f.write("not-a-token")  # would be E_CORE_UNAVAILABLE token-invalid if it were read first
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_SERVER_IDENTITY", "server-pid-mismatch"))

    def test_no_traceback_frame_holds_the_token(self) -> None:
        # A locals-capturing formatter (Sentry, rich show_locals) must not find the token after a failure.
        core = self.fake(pid=os.getpid() + 100000)
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        text = "".join(traceback.TracebackException.from_exception(cm.exception, capture_locals=True).format())
        self.assertNotIn(core.token, text)

        class BrokenSend:
            def peer_pid(self) -> int | None:
                return None

            def send(self, data: bytes, deadline: float) -> None:
                raise RpcError("E_TRANSPORT", "send failed", {"reason": "send-failed"})

            def recv_line(self, deadline: float) -> bytes:
                raise AssertionError("not reached")

            def close(self) -> None:
                pass

        os.unlink(os.path.join(self.home, "run", "core.pid"))
        c = self.client(transport_factory=lambda address, *, connect_timeout: BrokenSend())
        with self.assertRaises(RpcError) as cm:
            c.connect()
        exc = cm.exception
        text = "".join(traceback.TracebackException.from_exception(exc, capture_locals=True).format())
        self.assertNotIn(core.token, text)
        self.assertIsNone(exc.__context__, "no chained exception carries the send frame")

    def test_close_waits_at_most_its_deadline_and_aborts_the_call_without_retry(self) -> None:
        core = self.fake(handlers={"memory.recall": SILENT})
        c = self.client(call_timeout=5.0)
        c.connect()
        errors: list[RpcError] = []

        def call() -> None:
            try:
                c.recall(CALLER, "a", "q")
            except RpcError as e:
                errors.append(e)

        t = threading.Thread(target=call)
        t.start()
        time.sleep(0.1)
        t0 = time.monotonic()
        c.close(deadline_s=0.3)
        self.assertLess(time.monotonic() - t0, 0.3 + 0.25)
        t.join(2)
        self.assertFalse(t.is_alive())
        self.assertEqual((errors[0].code, errors[0].reason), ("E_TRANSPORT", "closed"))
        self.assertEqual(core.methods().count("memory.recall"), 1, "a closed client does not re-send")
        self.assertIsInstance(c.status(), dict, "the client reconnects on the next call after close()")

    def test_close_default_fits_the_session_end_budget(self) -> None:
        self.fake(handlers={"memory.recall": SILENT})
        c = self.client(call_timeout=5.0)
        c.connect()
        t = threading.Thread(target=lambda: self.assertRaises(RpcError, c.recall, CALLER, "a", "q"))
        t.start()
        time.sleep(0.1)
        t0 = time.monotonic()
        c.close()
        self.assertLess(time.monotonic() - t0, 2.0)
        t.join(2)

    def test_supports_stays_valid_during_a_reconnect(self) -> None:
        caps = default_capabilities()
        caps["methods"]["memory.checkpoint"] = {"stability": "experimental", "since": "1.0.0"}
        gate = threading.Event()
        release = threading.Event()
        core = self.fake(capabilities=caps)
        c = self.client()
        c.connect()
        self.assertTrue(c.supports("memory.checkpoint"))

        def slow_auth(params: dict) -> object:
            gate.set()
            release.wait(2)
            return core._auth(params)

        core.handlers["core.auth"] = slow_auth
        core.handlers["core.status"] = DROP
        t = threading.Thread(target=lambda: self.assertRaises(RpcError, c.status))
        t.start()
        self.assertTrue(gate.wait(2), "the reconnect handshake started")
        self.assertTrue(c.supports("memory.checkpoint"), "the previous hello stays until a new one is accepted")
        release.set()
        t.join(3)

    def test_a_relative_home_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            MemoryClient("relative/home")


if __name__ == "__main__":
    unittest.main()
