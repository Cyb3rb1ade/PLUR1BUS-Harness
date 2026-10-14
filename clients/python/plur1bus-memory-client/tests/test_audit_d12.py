"""Audit D12: regressions found in the hand-written client (transport, errors, close)."""

import copy
import os
import pickle
import resource
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest

from tests.fakes import FakeCore

from plur1bus_memory_client import MemoryClient, RpcError, UntrustedEndpoint, decode_line


class RecordingStream:
    """A transport double that records whether anything (the token) was sent."""

    def __init__(self, pid: int | None) -> None:
        self.pid = pid
        self.sent: list[bytes] = []
        self.closed = False

    def peer_pid(self) -> int | None:
        return self.pid

    def send(self, data: bytes, deadline: float) -> None:
        self.sent.append(data)
        raise RpcError("E_TRANSPORT", "stop", {"reason": "send-failed"})

    def recv_line(self, deadline: float) -> bytes:
        raise AssertionError("not reached")

    def close(self) -> None:
        self.closed = True


class WindowsMissingPidFileTest(unittest.TestCase):
    def test_a_missing_core_pid_is_refused_before_the_token_is_sent(self) -> None:
        # docs/rpc.md: on Windows "a missing pid file is a refusal (server-pid-unknown), not a skipped check".
        home = tempfile.mkdtemp(prefix="p1b-")
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        os.makedirs(os.path.join(home, "run"), mode=0o700)
        with open(os.path.join(home, "run", "core.token"), "w") as f:
            f.write("ab" * 32 + "\n")
        stream = RecordingStream(pid=4242)
        c = MemoryClient(home, platform="win32", transport_factory=lambda address, *, connect_timeout: stream)
        with self.assertRaises(RpcError) as cm:
            c.connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_SERVER_IDENTITY", "server-pid-unknown"))
        self.assertEqual(stream.sent, [], "the token reached a server nobody vouched for")


class DecodeLineTest(unittest.TestCase):
    def test_deeply_nested_json_is_a_protocol_error_not_a_recursion_error(self) -> None:
        line = b"[" * 200000 + b"]" * 200000
        with self.assertRaises(RpcError) as cm:
            decode_line(line)
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_PROTOCOL", "invalid-json"))


class RpcErrorCopyTest(unittest.TestCase):
    def test_pickle_and_copy_keep_code_message_and_data(self) -> None:
        e = RpcError("E_AGENT_UNKNOWN", "no such agent", {"reason": "x"})
        for clone in (pickle.loads(pickle.dumps(e)), copy.copy(e), copy.deepcopy(e)):
            self.assertEqual((clone.code, clone.message, clone.data), ("E_AGENT_UNKNOWN", "no such agent", {"reason": "x"}))
            self.assertEqual(str(clone), str(e))

    def test_untrusted_endpoint_survives_pickle(self) -> None:
        e = UntrustedEndpoint("run-dir-untrusted", "detail")
        clone = pickle.loads(pickle.dumps(e))
        self.assertIsInstance(clone, UntrustedEndpoint)
        self.assertEqual((clone.code, clone.reason), ("E_UNAUTHORIZED", "run-dir-untrusted"))


@unittest.skipIf(sys.platform == "win32" or not hasattr(socket, "AF_UNIX"), "POSIX transport")
class PosixTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="p1b-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)

    def test_close_during_a_connect_leaves_no_open_connection(self) -> None:
        core = FakeCore(self.home).start()
        self.addCleanup(core.stop)
        from plur1bus_memory_client.transport_posix import open_stream

        entered, release = threading.Event(), threading.Event()
        opened: list[object] = []

        def slow_factory(address: str, *, connect_timeout: float) -> object:
            entered.set()
            release.wait(3)
            s = open_stream(address, connect_timeout=connect_timeout)
            opened.append(s)
            return s

        c = MemoryClient(self.home, transport_factory=slow_factory, call_timeout=5.0)
        errors: list[RpcError] = []

        def call() -> None:
            try:
                c.status()
            except RpcError as e:
                errors.append(e)

        t = threading.Thread(target=call)
        t.start()
        self.assertTrue(entered.wait(2))
        c.close(deadline_s=0.05)  # the connect holds the lock; close cannot wait for it
        release.set()
        t.join(5)
        self.assertFalse(t.is_alive())
        self.assertIsNone(c._stream, "a connection made after close() was kept open")  # noqa: SLF001
        self.assertEqual([(e.code, e.reason) for e in errors], [("E_TRANSPORT", "closed")])

    def test_a_stream_dropped_without_close_releases_its_wake_pipe(self) -> None:
        import gc

        from plur1bus_memory_client.transport_posix import PosixStream

        def count() -> int:
            return len(os.listdir("/proc/self/fd")) if os.path.isdir("/proc/self/fd") else -1

        if count() < 0:
            self.skipTest("needs /proc/self/fd")
        gc.collect()
        before = count()
        for _ in range(20):
            a, b = socket.socketpair()
            PosixStream(a)
            b.close()
        gc.collect()
        self.assertLessEqual(count(), before + 1, "the wake pipe of an unclosed stream leaked")

    def test_is_stale_works_for_descriptors_above_the_select_limit(self) -> None:
        from plur1bus_memory_client.transport_posix import PosixStream

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if soft != resource.RLIM_INFINITY and soft < 1100:
            if hard != resource.RLIM_INFINITY and hard < 1100:
                self.skipTest("fd limit too low")
            resource.setrlimit(resource.RLIMIT_NOFILE, (1100, hard))
        a, b = socket.socketpair()
        self.addCleanup(b.close)
        high = os.dup2(a.fileno(), 1050)
        a.close()
        sock = socket.socket(fileno=high)
        stream = PosixStream(sock)
        self.addCleanup(stream.close)
        self.assertFalse(stream.is_stale(), "an idle healthy connection with fd >= 1024 was called stale")
        b.send(b"x")
        time.sleep(0.05)
        self.assertTrue(stream.is_stale())


if __name__ == "__main__":
    unittest.main()
