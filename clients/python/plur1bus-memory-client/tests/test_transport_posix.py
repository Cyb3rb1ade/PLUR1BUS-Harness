"""Socket-level tests of transport_posix.PosixStream: framing across recv chunks, both oversize branches,
staleness, and a non-JSON reply from the core followed by a reconnect."""

import json
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from tests.fakes import FakeCore, Raw

from plur1bus_memory_client import MAX_LINE, MemoryClient, RpcError, read_response
from plur1bus_memory_client.transport_posix import PosixStream


def _deadline(s: float = 2.0) -> float:
    return time.monotonic() + s


@unittest.skipIf(sys.platform == "win32" or not hasattr(socket, "AF_UNIX"), "POSIX transport")
class PosixStreamTest(unittest.TestCase):
    def setUp(self) -> None:
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        self.stream = PosixStream(a)
        self.peer = b
        self.addCleanup(self.stream.close)
        self.addCleanup(self.peer.close)

    def feed(self, chunks: list[bytes], pause: float = 0.02, close: bool = False) -> threading.Thread:
        def run() -> None:
            try:
                for c in chunks:
                    self.peer.sendall(c)
                    time.sleep(pause)
                if close:
                    self.peer.shutdown(socket.SHUT_WR)
            except OSError:
                pass

        t = threading.Thread(target=run, daemon=True)
        t.start()
        self.addCleanup(t.join, 5)
        return t

    def test_a_response_split_across_chunks_is_reassembled(self) -> None:
        line = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"text": "Jürgen İ " * 50}}).encode("utf-8")
        cut1, cut2 = 7, len(line) // 2 + 1  # the second cut lands inside a multi-byte character or not; both fine
        self.feed([line[:cut1], line[cut1:cut2], line[cut2:] + b"\n"])
        self.assertEqual(read_response(self.stream, 1, _deadline())["text"], "Jürgen İ " * 50)

    def test_two_lines_in_one_chunk_are_returned_one_by_one(self) -> None:
        self.feed([b'{"a":1}\n{"b":2}\r\n'])
        self.assertEqual(self.stream.recv_line(_deadline()), b'{"a":1}')
        self.assertEqual(self.stream.recv_line(_deadline()), b'{"b":2}')

    def test_a_line_of_exactly_max_line_bytes_is_accepted(self) -> None:
        body = b"x" * MAX_LINE
        self.feed([body[i : i + (1 << 20)] for i in range(0, MAX_LINE, 1 << 20)] + [b"\n"], pause=0)
        self.assertEqual(len(self.stream.recv_line(_deadline(10))), MAX_LINE)

    def test_an_endless_line_is_refused_once_the_buffer_passes_max_line(self) -> None:
        # No LF ever arrives: the no-newline branch must stop reading at MAX_LINE plus at most one chunk.
        stop = threading.Event()

        def flood() -> None:
            chunk = b"y" * 65536
            try:
                while not stop.is_set():
                    self.peer.sendall(chunk)
            except OSError:
                pass

        t = threading.Thread(target=flood, daemon=True)
        t.start()
        with self.assertRaises(RpcError) as cm:
            self.stream.recv_line(_deadline(10))
        stop.set()
        self.stream.close()
        t.join(5)
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_PROTOCOL", "line-too-long"))
        self.assertLessEqual(len(self.stream._buf), MAX_LINE + 65536 + 1)

    def test_both_oversize_branches(self) -> None:
        # A complete line longer than MAX_LINE (LF present) ...
        self.stream._buf = bytearray(b"z" * (MAX_LINE + 1) + b"\n")
        with self.assertRaises(RpcError) as cm:
            self.stream.recv_line(_deadline())
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_PROTOCOL", "line-too-long"))
        # ... and an unterminated one past MAX_LINE (no LF, no recv needed).
        self.stream._buf = bytearray(b"z" * (MAX_LINE + 1))
        with self.assertRaises(RpcError) as cm:
            self.stream.recv_line(_deadline())
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_PROTOCOL", "line-too-long"))

    def test_eof_mid_line_is_a_transport_error(self) -> None:
        self.feed([b'{"partial":'], close=True)
        with self.assertRaises(RpcError) as cm:
            self.stream.recv_line(_deadline())
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_TRANSPORT", "eof"))

    def test_recv_honours_the_deadline(self) -> None:
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            self.stream.recv_line(_deadline(0.2))
        self.assertEqual(cm.exception.code, "E_TIMEOUT")
        self.assertLess(time.monotonic() - t0, 0.45)

    def test_is_stale(self) -> None:
        self.assertFalse(self.stream.is_stale(), "a live idle connection")
        self.peer.sendall(b'{"jsonrpc":"2.0","method":"core.state","params":{}}\n')
        self.peer.close()
        time.sleep(0.05)
        self.assertTrue(self.stream.is_stale(), "data followed by EOF")

    def test_is_stale_after_a_plain_close_and_with_unsolicited_data(self) -> None:
        self.peer.close()
        time.sleep(0.05)
        self.assertTrue(self.stream.is_stale())
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(b.close)
        s2 = PosixStream(a)
        self.addCleanup(s2.close)
        b.sendall(b'{"late":true}\n')
        time.sleep(0.05)
        self.assertTrue(s2.is_stale(), "unsolicited bytes on an idle connection")

    def test_close_wakes_a_blocked_recv(self) -> None:
        errors: list[RpcError] = []

        def blocked() -> None:
            try:
                self.stream.recv_line(_deadline(5))
            except RpcError as e:
                errors.append(e)

        t = threading.Thread(target=blocked)
        t.start()
        time.sleep(0.1)
        t0 = time.monotonic()
        self.stream.close()
        t.join(2)
        self.assertFalse(t.is_alive())
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual((errors[0].code, errors[0].reason), ("E_TRANSPORT", "closed"))

    def test_close_wakes_a_blocked_recv_even_when_shutdown_does_not(self) -> None:
        # macOS (CI round 1, macos-15): shutdown(SHUT_RDWR) on an AF_UNIX socket does not wake a poll() on it in
        # another thread. With shutdown a no-op here, the wake-up has to come from the stream's own wake pipe.
        errors: list[RpcError] = []

        def blocked() -> None:
            try:
                self.stream.recv_line(_deadline(5))
            except RpcError as e:
                errors.append(e)

        with mock.patch.object(socket.socket, "shutdown", lambda *_a, **_k: None):
            t = threading.Thread(target=blocked)
            t.start()
            time.sleep(0.1)
            t0 = time.monotonic()
            self.stream.close()
            t.join(2)
        self.assertFalse(t.is_alive())
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual((errors[0].code, errors[0].reason), ("E_TRANSPORT", "closed"))
        self.assertIsNone(self.stream._sock, "the call that was woken released the socket as it left")

    def test_close_wakes_a_blocked_send(self) -> None:
        # The peer never reads: the send buffer fills and send() waits for POLLOUT until close() wakes it.
        errors: list[RpcError] = []

        def blocked() -> None:
            try:
                self.stream.send(b"s" * (8 << 20), _deadline(5))
            except RpcError as e:
                errors.append(e)

        with mock.patch.object(socket.socket, "shutdown", lambda *_a, **_k: None):
            t = threading.Thread(target=blocked)
            t.start()
            time.sleep(0.2)
            self.assertTrue(t.is_alive(), "send is blocked on a full buffer")
            self.stream.close()
            t.join(2)
        self.assertFalse(t.is_alive())
        self.assertEqual((errors[0].code, errors[0].reason), ("E_TRANSPORT", "closed"))

    def test_a_closed_stream_refuses_calls_and_close_is_idempotent(self) -> None:
        self.stream.close()
        self.stream.close()
        for call in (lambda: self.stream.send(b"x\n", _deadline()), lambda: self.stream.recv_line(_deadline())):
            with self.assertRaises(RpcError) as cm:
                call()
            self.assertEqual((cm.exception.code, cm.exception.reason), ("E_TRANSPORT", "closed"))
        self.assertTrue(self.stream.is_stale())


@unittest.skipIf(sys.platform == "win32" or not hasattr(socket, "AF_UNIX"), "POSIX transport")
class NonJsonReplyTest(unittest.TestCase):
    def test_a_non_json_reply_drops_the_connection_and_the_next_call_reconnects(self) -> None:
        home = tempfile.mkdtemp(prefix="p1b-")
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        state = {"raw": True}
        core = FakeCore(home, handlers={"core.status": lambda _p: Raw(b"<html>not json") if state["raw"] else {"ok": 1}}).start()
        self.addCleanup(core.stop)
        c = MemoryClient(home)
        self.addCleanup(c.close)
        with self.assertRaises(RpcError) as cm:
            c.status()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_PROTOCOL", "invalid-json"))
        self.assertEqual(core.methods().count("core.status"), 1, "a protocol error is not retried")
        state["raw"] = False
        self.assertEqual(c.status(), {"ok": 1})
        self.assertEqual(core.connections, 2, "the poisoned connection was not reused")


if __name__ == "__main__":
    unittest.main()
