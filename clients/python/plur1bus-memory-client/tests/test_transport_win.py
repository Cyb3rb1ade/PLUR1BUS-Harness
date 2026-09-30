"""Tests of transport_win (HM2-R11, S11).

- Any OS: the module imports without ``ctypes.windll``; it binds kernel32 correctly under a simulated
  ``win32``; and the overlapped state machine runs against ``FakeKernel32`` (timeouts, ``CancelIoEx``,
  ``ERROR_PIPE_BUSY`` retry inside the deadline, ``ERROR_MORE_DATA``, a broken pipe mid-read, the pid
  check, close from another thread, staleness).
- Windows only: the same client against ``FakePipeCore``, a real ``CreateNamedPipeW`` server.
"""

from __future__ import annotations

import ctypes
import importlib
import json
import os
import secrets
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from tests import FIXTURES_DIR
from tests.fakes import SILENT, Raw
from tests.fakes_win import BUSY_FOREVER, FakeKernel32, write_run_files

from plur1bus_memory_client import MAX_LINE, Caller, MemoryClient, RpcError, core_address
from plur1bus_memory_client import transport_win
from plur1bus_memory_client.transport_win import (
    ERROR_IO_PENDING,
    ERROR_OPERATION_ABORTED,
    OPEN_EXISTING,
    OPEN_FLAGS,
    WAIT_TIMEOUT,
    WinPipeStream,
    open_stream,
)

CALLER = Caller("hermes:cli", "local")
ON_WINDOWS = sys.platform == "win32"


def _deadline(s: float = 2.0) -> float:
    return time.monotonic() + s


# -- import and binding ----------------------------------------------------------------------------------


class _NoWindll:
    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"ctypes.windll.{name} touched at import time")


def _fresh_import(name: str) -> object:
    """Import ``name`` afresh, then put the original module back (in ``sys.modules`` and on its package)."""
    parent, _, attr = name.rpartition(".")
    saved = sys.modules.pop(name, None)
    try:
        return importlib.import_module(name)
    finally:
        if saved is not None:
            sys.modules[name] = saved
            setattr(sys.modules[parent], attr, saved)


class ImportTest(unittest.TestCase):
    def test_transport_win_imports_without_windll(self) -> None:
        def no_windll(*_a: object, **_k: object) -> None:
            raise AssertionError("ctypes.WinDLL called at import time")

        with mock.patch.object(ctypes, "WinDLL", no_windll, create=True), mock.patch.object(
            ctypes, "windll", _NoWindll(), create=True
        ):
            mod = _fresh_import("plur1bus_memory_client.transport_win")
            client = _fresh_import("plur1bus_memory_client.client")
            self.assertTrue(callable(mod.open_stream))
            # Selecting the win32 factory does not import or bind anything either.
            factory = client._default_factory("win32")  # type: ignore[attr-defined]
            self.assertTrue(callable(factory))

    def test_open_stream_off_windows_without_an_api_is_a_transport_error(self) -> None:
        if ON_WINDOWS:
            self.skipTest("off-Windows behaviour")
        with self.assertRaises(RpcError) as cm:
            open_stream(r"\\.\pipe\plur1bus-0000000000000000-core", connect_timeout=0.5)
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_TRANSPORT", "not-windows"))


class _FakeFn:
    """A kernel32 function stand-in: records argtypes/restype and calls, returns ``ret(*args)``."""

    def __init__(self, name: str, dll: _FakeDll) -> None:
        self.name, self.dll = name, dll
        self.argtypes: list | None = None
        self.restype: object = "unset"

    def __call__(self, *args: object) -> object:
        self.dll.calls.append((self.name, args))
        ret = self.dll.returns.get(self.name, 1)
        return ret(*args) if callable(ret) else ret


class _FakeDll:
    def __init__(self) -> None:
        self.fns: dict[str, _FakeFn] = {}
        self.calls: list[tuple[str, tuple]] = []
        self.returns: dict[str, object] = {}
        self.last_error = 0

    def __getattr__(self, name: str) -> _FakeFn:
        if name.startswith("_"):
            raise AttributeError(name)
        fn = self.fns.get(name)
        if fn is None:
            fn = self.fns[name] = _FakeFn(name, self)
        return fn


class Kernel32BindingTest(unittest.TestCase):
    """The real ``Kernel32Api`` against a fake DLL: the ctypes layer is wired and sequenced right."""

    def api(self) -> tuple[transport_win.Kernel32Api, _FakeDll]:
        dll = _FakeDll()
        return transport_win.Kernel32Api(dll, last_error=lambda: dll.last_error), dll

    def test_default_api_loads_kernel32_with_use_last_error_under_win32(self) -> None:
        seen: list[tuple] = []
        dll = _FakeDll()

        def win_dll(name: str, **kw: object) -> _FakeDll:
            seen.append((name, kw))
            return dll

        with mock.patch.object(sys, "platform", "win32"), mock.patch.object(ctypes, "WinDLL", win_dll, create=True), mock.patch.object(
            ctypes, "get_last_error", lambda: 0, create=True
        ), mock.patch.object(transport_win, "_API", None):
            api = transport_win._default_api()
            self.assertIs(transport_win._default_api(), api, "bound once")
        self.assertEqual(seen, [("kernel32", {"use_last_error": True})])
        for name in (
            "CreateFileW",
            "WaitNamedPipeW",
            "GetNamedPipeServerProcessId",
            "PeekNamedPipe",
            "CreateEventW",
            "ReadFile",
            "WriteFile",
            "WaitForSingleObject",
            "CancelIoEx",
            "GetOverlappedResult",
            "CloseHandle",
        ):
            fn = dll.fns[name]
            self.assertIsNotNone(fn.argtypes, name)
            self.assertNotEqual(fn.restype, "unset", name)

    def test_open_pipe_asks_for_overlapped_io_and_identification_only(self) -> None:
        api, dll = self.api()
        dll.returns["CreateFileW"] = 1234
        self.assertEqual(api.open_pipe(r"\\.\pipe\x"), 1234)
        name, args = dll.calls[-1]
        self.assertEqual(args[0], r"\\.\pipe\x")
        self.assertEqual(args[1], transport_win.GENERIC_READ | transport_win.GENERIC_WRITE)
        self.assertEqual(args[4], OPEN_EXISTING)
        self.assertEqual(args[5], OPEN_FLAGS)
        self.assertEqual(OPEN_FLAGS, 0x40000000 | 0x00100000 | 0x00010000)

    def test_an_invalid_handle_raises_the_last_error(self) -> None:
        api, dll = self.api()
        dll.returns["CreateFileW"] = ctypes.c_void_p(-1).value
        dll.last_error = transport_win.ERROR_PIPE_BUSY
        with self.assertRaises(transport_win.Win32Error) as cm:
            api.open_pipe(r"\\.\pipe\x")
        self.assertEqual(cm.exception.code, transport_win.ERROR_PIPE_BUSY)

    def test_server_pid_reads_the_ulong_out_parameter(self) -> None:
        api, dll = self.api()

        def fill(_h: object, pid_ref: object) -> int:
            pid_ref._obj.value = 777  # type: ignore[attr-defined]
            return 1

        dll.returns["GetNamedPipeServerProcessId"] = fill
        self.assertEqual(api.server_pid(5), 777)
        dll.returns["GetNamedPipeServerProcessId"] = 0
        self.assertIsNone(api.server_pid(5))

    def test_a_timed_out_read_cancels_its_overlapped_and_waits_before_releasing_it(self) -> None:
        api, dll = self.api()
        dll.returns["CreateEventW"] = 77
        dll.returns["ReadFile"] = 0
        dll.last_error = ERROR_IO_PENDING
        dll.returns["WaitForSingleObject"] = WAIT_TIMEOUT

        def aborted(*_a: object) -> int:
            dll.last_error = ERROR_OPERATION_ABORTED
            return 0

        dll.returns["GetOverlappedResult"] = aborted
        stream = WinPipeStream(api, 55)
        with self.assertRaises(RpcError) as cm:
            stream.recv_line(_deadline(0.05))
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_TIMEOUT", "recv-timeout"))
        names = [n for n, _ in dll.calls]
        self.assertEqual(names, ["CreateEventW", "ReadFile", "WaitForSingleObject", "CancelIoEx", "GetOverlappedResult", "CloseHandle"])
        read_ov = dll.calls[1][1][4]._obj  # the OVERLAPPED passed by reference
        cancel_ov = dll.calls[3][1][1]._obj
        result = dll.calls[4][1]
        self.assertIs(read_ov, cancel_ov, "CancelIoEx names exactly this operation")
        self.assertIs(result[1]._obj, read_ov)
        self.assertTrue(result[3], "GetOverlappedResult(wait=TRUE) after the cancel")
        self.assertEqual(read_ov.hEvent, 77)
        self.assertEqual(dll.calls[5][1], (77,), "only the event is released; the pipe handle stays open")
        stream.close()
        self.assertEqual(dll.calls[-1], ("CloseHandle", (55,)))


# -- the overlapped state machine against FakeKernel32 (any OS) ---------------------------------------------


class _FakeClientCase(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="p1b-win-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.token = secrets.token_hex(32)
        self.clients: list[MemoryClient] = []

    def tearDown(self) -> None:
        for c in self.clients:
            c.close()
        k = getattr(self, "k", None)
        if k is not None:
            self.assertEqual(k.events_open, 0, "every OVERLAPPED event was released")
            self.assertEqual(k.closed_under_pending, 0, "no handle was closed under a pending operation")

    def fake(self, *, pid_file: int | None = 4242, **kw: object) -> FakeKernel32:
        self.k = FakeKernel32(token=self.token, **kw)  # type: ignore[arg-type]
        write_run_files(self.home, self.token, pid_file)
        return self.k

    def client(self, **kw: object) -> MemoryClient:
        k = self.k

        def factory(address: str, *, connect_timeout: float) -> WinPipeStream:
            return open_stream(address, connect_timeout=connect_timeout, api=k)

        c = MemoryClient(self.home, platform="win32", transport_factory=factory, **kw)  # type: ignore[arg-type]
        self.clients.append(c)
        return c


class FakePipeClientTest(_FakeClientCase):
    def test_round_trip_over_the_fake_pipe(self) -> None:
        k = self.fake()
        c = self.client()
        self.assertEqual(c.connect()["rpc"], "1.4.0")
        self.assertIsInstance(c.status(), dict)
        self.assertEqual(k.addresses, [core_address(self.home, "win32")])
        self.assertEqual(k.methods(), ["core.auth", "core.status"])
        self.assertNotIn(self.token, repr(k.log))

    def test_round_trip_with_synchronous_completions(self) -> None:
        self.fake(sync=True)
        self.assertIsInstance(self.client().status(), dict)

    def test_pid_check_refuses_a_mismatch_before_anything_is_written(self) -> None:
        k = self.fake(pid_file=1234)  # the server reports 4242
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_SERVER_IDENTITY", "server-pid-mismatch"))
        self.assertEqual((cm.exception.data["expected"], cm.exception.data["actual"]), (1234, 4242))
        self.assertEqual(k.writes, [], "no byte, least of all the token, reached the pipe")
        self.assertEqual(k.calls("start"), [])
        self.assertEqual(k.calls("close"), [("close", k.last().handle)])
        self.assertNotIn(self.token, str(cm.exception))

    def test_a_server_the_os_cannot_name_is_refused(self) -> None:
        k = self.fake(server_pid=None)
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual(cm.exception.reason, "server-pid-mismatch")
        self.assertIsNone(cm.exception.data["actual"])
        self.assertEqual(k.writes, [])

    def test_read_timeout_cancels_the_read_and_a_later_call_uses_a_new_connection(self) -> None:
        state = {"silent": True}
        k = self.fake(handlers={"core.status": lambda _p: SILENT if state["silent"] else {"ok": 1}})
        c = self.client(call_timeout=0.3)
        c.connect()
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            c.status()
        elapsed = time.monotonic() - t0
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_TIMEOUT", "recv-timeout"))
        self.assertLess(elapsed, 0.3 + 0.25)
        first = k.last().handle
        # The pending read was cancelled by CancelIoEx, awaited with GetOverlappedResult(wait=TRUE), and only
        # then was the handle closed.
        cancel_i = k.log.index(next(e for e in k.log if e[0] == "cancel" and e[1] == first))
        op_id = k.log[cancel_i][2]
        self.assertIsNotNone(op_id, "the cancel names the one operation")
        result_i = k.log.index(("result", first, op_id, True))
        free_i = k.log.index(("free_op", op_id))
        close_i = k.log.index(("close", first))
        self.assertLess(cancel_i, result_i)
        self.assertLess(result_i, free_i)
        self.assertLess(free_i, close_i)
        state["silent"] = False
        self.assertEqual(c.status(), {"ok": 1})
        self.assertEqual(k.opens, 2)

    def test_a_read_that_completes_while_it_is_cancelled_still_counts(self) -> None:
        k = self.fake()
        k.complete_on_cancel = b'{"late":1}\n'
        stream = WinPipeStream(k, k.open_pipe("x"))
        self.addCleanup(stream.close)
        self.assertEqual(stream.recv_line(_deadline(0.05)), b'{"late":1}')

    def test_send_deadline_cancels_a_stalled_write(self) -> None:
        k = self.fake()
        c = self.client(call_timeout=0.3)
        c.connect()
        k.stall_writes = True
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            c.capture(CALLER, "hermes-default", [{"role": "user", "content": "x"}])
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_TIMEOUT", "send-timeout"))
        self.assertLess(time.monotonic() - t0, 0.3 + 0.25)
        self.assertTrue(k.calls("cancel"))

    def test_busy_pipe_is_retried_within_the_deadline(self) -> None:
        k = self.fake(busy=3)
        c = self.client(connect_timeout=1.0)
        self.assertEqual(c.connect()["rpc"], "1.4.0")
        waits = [ms for _, ms in k.calls("wait_named_pipe")]
        self.assertEqual(len(waits), 3)
        self.assertTrue(all(1 <= ms <= 1000 for ms in waits), waits)
        self.assertEqual(len(k.calls("open")), 4)

    def test_busy_pipe_waits_up_to_connect_timeout_then_core_unavailable(self) -> None:
        k = self.fake(busy=BUSY_FOREVER)
        c = self.client(connect_timeout=0.4)
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            c.connect()
        elapsed = time.monotonic() - t0
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_CORE_UNAVAILABLE", "pipe-busy"))
        self.assertGreaterEqual(elapsed, 0.35)
        self.assertLess(elapsed, 0.4 + 0.25)
        self.assertEqual(k.writes, [])

    def test_a_missing_pipe_is_core_unavailable(self) -> None:
        self.fake(exists=False)
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_CORE_UNAVAILABLE", "no-pipe"))

    def test_more_data_reads_are_reassembled_into_one_line(self) -> None:
        big = "Jürgen " * 40000  # ~ 320 KB: five reads of 64 KiB, four of them ERROR_MORE_DATA
        k = self.fake(message_mode=True, handlers={"core.status": {"text": big}})
        self.assertEqual(self.client().status()["text"], big)
        self.assertEqual(k.events_open, 0)

    def test_more_data_with_synchronous_completions(self) -> None:
        big = "x" * 200000
        self.fake(message_mode=True, sync=True, handlers={"core.status": {"text": big}})
        self.assertEqual(self.client().status()["text"], big)

    def test_broken_pipe_mid_read_is_eof_and_a_read_is_retried_on_a_new_connection(self) -> None:
        state = {"n": 0}
        k = self.fake()

        def status(_p: dict) -> object:
            state["n"] += 1
            if state["n"] == 1:
                k.push(b'{"jsonrpc":"2.0","id":')  # half a line, then the server goes away
                k.break_pipe()
                return SILENT
            return {"ok": 2}

        k.responder.handlers["core.status"] = status
        c = self.client()
        self.assertEqual(c.status(), {"ok": 2})
        self.assertEqual(k.opens, 2)

    def test_broken_pipe_mid_read_of_a_write_is_a_transport_error(self) -> None:
        k = self.fake()

        def capture(_p: dict) -> object:
            k.push(b'{"jsonrpc"')
            k.break_pipe()
            return SILENT

        k.responder.handlers["memory.capture"] = capture
        c = self.client()
        with self.assertRaises(RpcError) as cm:
            c.capture(CALLER, "hermes-default", [{"role": "user", "content": "x"}])
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_TRANSPORT", "eof"))
        self.assertEqual(k.methods().count("memory.capture"), 1, "a write is never re-sent")

    def test_line_over_4_mib_from_the_server_is_refused(self) -> None:
        self.fake(handlers={"core.status": Raw(b"z" * (MAX_LINE + 1))})
        with self.assertRaises(RpcError) as cm:
            self.client(call_timeout=10).status()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_PROTOCOL", "line-too-long"))

    def test_close_from_another_thread_aborts_the_pending_read_and_the_handle_closes_after_it(self) -> None:
        k = self.fake()
        h = k.open_pipe("x")
        stream = WinPipeStream(k, h)
        errors: list[RpcError] = []

        def blocked() -> None:
            try:
                stream.recv_line(_deadline(5))
            except RpcError as e:
                errors.append(e)

        t = threading.Thread(target=blocked)
        t.start()
        time.sleep(0.1)
        t0 = time.monotonic()
        stream.close()
        self.assertLess(time.monotonic() - t0, 0.1, "close() does not wait for the read")
        t.join(2)
        self.assertFalse(t.is_alive())
        self.assertEqual((errors[0].code, errors[0].reason), ("E_TRANSPORT", "closed"))
        self.assertEqual(k.calls("cancel"), [("cancel", h, None)])
        self.assertEqual(k.calls("close"), [("close", h)], "closed once")
        self.assertGreater(k.log.index(("close", h)), max(i for i, e in enumerate(k.log) if e[0] == "free_op"))
        self.assertIsNone(stream.peer_pid())
        stream.close()  # idempotent
        self.assertEqual(len(k.calls("close")), 1)

    def test_client_close_bounds_an_in_flight_call(self) -> None:
        k = self.fake(handlers={"core.status": SILENT})
        c = self.client(call_timeout=5)
        c.connect()
        errors: list[RpcError] = []

        def call() -> None:
            try:
                c.status()
            except RpcError as e:
                errors.append(e)

        t = threading.Thread(target=call)
        t.start()
        time.sleep(0.1)
        t0 = time.monotonic()
        c.close(deadline_s=0.2)
        t.join(2)
        self.assertLess(time.monotonic() - t0, 0.6)
        self.assertEqual((errors[0].code, errors[0].reason), ("E_TRANSPORT", "closed"))
        self.assertEqual(k.methods().count("core.status"), 1, "not re-sent after a close")

    def test_is_stale(self) -> None:
        k = self.fake()
        c = self.client()
        c.connect()
        stream = c._stream  # noqa: SLF001
        self.assertFalse(stream.is_stale(), "a live idle connection")
        k.push(b'{"jsonrpc":"2.0","method":"core.state","params":{}}\n')
        self.assertTrue(stream.is_stale(), "unsolicited bytes")
        # The client notices before sending and reconnects instead of reading the stray line as an answer.
        self.assertIsInstance(c.status(), dict)
        self.assertEqual(k.opens, 2)
        k.break_pipe()
        self.assertTrue(c._stream.is_stale(), "the server closed its end")  # noqa: SLF001
        self.assertIsInstance(c.status(), dict)
        self.assertEqual(k.opens, 3, "the first call after a server close goes over a fresh connection")

    def test_no_time_left_to_connect(self) -> None:
        k = self.fake()
        with self.assertRaises(RpcError) as cm:
            open_stream("x", connect_timeout=0, api=k)
        self.assertEqual(cm.exception.code, "E_TIMEOUT")
        self.assertEqual(k.log, [])


# -- real named pipes (Windows only) ----------------------------------------------------------------------


@unittest.skipUnless(ON_WINDOWS, "real named pipes: Windows only (runs in the windows-2025 CI job)")
class NamedPipeTest(unittest.TestCase):
    def setUp(self) -> None:
        from tests.fakes_win import FakePipeCore

        self.FakePipeCore = FakePipeCore
        self.home = tempfile.mkdtemp(prefix="p1b-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.clients: list[MemoryClient] = []

    def tearDown(self) -> None:
        for c in self.clients:
            c.close()

    def core(self, home: str | None = None, **kw: object) -> object:
        core = self.FakePipeCore(home or self.home, **kw).start()  # type: ignore[arg-type]
        self.addCleanup(core.stop)
        return core

    def client(self, home: str | None = None, **kw: object) -> MemoryClient:
        c = MemoryClient(home or self.home, **kw)  # type: ignore[arg-type]
        self.clients.append(c)
        return c

    def test_round_trip_over_a_named_pipe(self) -> None:
        core = self.core()
        c = self.client()
        self.assertEqual(c.connect()["rpc"], "1.4.0")
        self.assertIsInstance(c.status(), dict)
        self.assertEqual(core.methods(), ["core.auth", "core.status"])
        self.assertEqual(c._stream.peer_pid(), os.getpid())  # noqa: SLF001

    def test_squatted_pipe_with_another_server_pid_gets_no_token(self) -> None:
        core = self.core(pid=os.getpid() + 100000)  # run/core.pid names another process than the server
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_SERVER_IDENTITY", "server-pid-mismatch"))
        time.sleep(0.1)
        self.assertNotIn("core.auth", core.methods())
        self.assertEqual(core.calls, [], "nothing at all was sent")
        self.assertNotIn(core.token, str(cm.exception))

    def test_read_deadline_cancels_the_pending_read(self) -> None:
        state = {"silent": True}
        core = self.core(handlers={"core.status": lambda _p: SILENT if state["silent"] else {"ok": 1}})
        c = self.client(call_timeout=0.5)
        c.connect()
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            c.status()
        self.assertEqual(cm.exception.code, "E_TIMEOUT")
        self.assertLess(time.monotonic() - t0, 0.5 + 0.25)
        state["silent"] = False
        self.assertEqual(c.status(), {"ok": 1})
        self.assertEqual(core.connections, 2, "the later call used a new connection")

    def test_busy_pipe_waits_up_to_connect_timeout(self) -> None:
        core = self.core(max_instances=1)
        holder = open_stream(core.address, connect_timeout=2)
        self.addCleanup(holder.close)
        c = self.client(connect_timeout=0.5)
        t0 = time.monotonic()
        with self.assertRaises(RpcError) as cm:
            c.connect()
        elapsed = time.monotonic() - t0
        self.assertEqual(cm.exception.code, "E_CORE_UNAVAILABLE")
        self.assertGreaterEqual(elapsed, 0.4)
        self.assertLess(elapsed, 0.5 + 0.5)

    def test_non_ascii_home_pipe_name(self) -> None:
        with open(os.path.join(FIXTURES_DIR, "address-vectors.json"), encoding="utf-8") as f:
            vector = next(v for v in json.load(f) if "Jürgen A" in v["home"] and v["platform"] == "win32")
        self.assertEqual(core_address(vector["home"], "win32"), vector["address"])
        # The fake serves the vector's exact pipe name; a stream reaches it and gets an answer.
        core = self.core(address=vector["address"])
        s = open_stream(vector["address"], connect_timeout=2)
        self.addCleanup(s.close)
        s.send(b'{"jsonrpc":"2.0","id":1,"method":"core.auth","params":{"token":"' + core.token.encode() + b'"}}\n', _deadline())
        self.assertEqual(json.loads(s.recv_line(_deadline()))["result"]["rpc"], "1.4.0")
        # And a whole client works from a real home with a space and non-ASCII in its path.
        home = os.path.join(self.home, "Jürgen A", "PLUR1BUS")
        os.makedirs(home)
        self.core(home=home)
        self.assertIsInstance(self.client(home=home).status(), dict)

    def test_line_over_4_mib_from_server_is_refused(self) -> None:
        self.core(handlers={"core.status": Raw(b"z" * (MAX_LINE + 1))})
        with self.assertRaises(RpcError) as cm:
            self.client(call_timeout=20).status()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_PROTOCOL", "line-too-long"))


if __name__ == "__main__":
    unittest.main()
