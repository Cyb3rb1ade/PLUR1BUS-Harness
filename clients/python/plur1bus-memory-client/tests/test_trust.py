"""Local endpoint trust (audit M2): the Python client refuses like the Rust and TypeScript clients.

Offline only: temp dirs, a local fake core on a unix socket, injected ``euid``/``lstat``/peer uid for the
cases that need another user.
"""

import os
import shutil
import socket
import stat
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

from tests.fakes import FakeCore

from plur1bus_memory_client import Caller, MemoryClient, RpcError, UntrustedEndpoint, is_trust_refusal
from plur1bus_memory_client import trust
from plur1bus_memory_client.transport_posix import open_stream

CALLER = Caller("hermes:cli", "local")
POSIX = sys.platform != "win32" and hasattr(socket, "AF_UNIX")


def st(*, mode: int, uid: int = 1000):
    return types.SimpleNamespace(st_mode=mode, st_uid=uid)


DIR = st(mode=stat.S_IFDIR | 0o700)


class TrustUnitTest(unittest.TestCase):
    """Pure checks with injected metadata (a foreign owner needs no second user)."""

    def refuse(self, fn, *a, **kw) -> UntrustedEndpoint:
        with self.assertRaises(RpcError) as cm:
            fn(*a, **kw)
        e = cm.exception
        self.assertIsInstance(e, UntrustedEndpoint)
        self.assertEqual(e.code, "E_UNAUTHORIZED")
        self.assertEqual(e.data["legacy_code"], "E_SERVER_IDENTITY")
        self.assertTrue(is_trust_refusal(e))
        return e

    def run_dir(self, meta, euid=1000):
        return trust.check_run_dir("/h/run", platform="linux", euid=euid, lstat=lambda p: meta)

    @unittest.skipUnless(POSIX, "POSIX only")
    def test_private_and_group_readable_dirs_of_ours_pass(self) -> None:
        self.run_dir(DIR)
        self.run_dir(st(mode=stat.S_IFDIR | 0o755))

    @unittest.skipUnless(POSIX, "POSIX only")
    def test_untrusted_directories_are_refused(self) -> None:
        for bad in (
            st(mode=stat.S_IFLNK | 0o777),
            st(mode=stat.S_IFREG | 0o600),
            st(mode=stat.S_IFDIR | 0o700, uid=1001),
            st(mode=stat.S_IFDIR | 0o770),
            st(mode=stat.S_IFDIR | 0o707),
            st(mode=stat.S_IFDIR | 0o777),
        ):
            with self.subTest(mode=oct(bad.st_mode), uid=bad.st_uid):
                self.assertEqual(self.refuse(self.run_dir, bad).reason, "run-dir-untrusted")

    @unittest.skipUnless(POSIX, "POSIX only")
    def test_a_missing_dir_is_core_absent_and_an_unreadable_one_is_refused(self) -> None:
        def missing(p):
            raise FileNotFoundError(p)

        def denied(p):
            raise PermissionError(13, "Permission denied", p)

        with self.assertRaises(FileNotFoundError):
            trust.check_run_dir("/h/run", platform="linux", euid=1000, lstat=missing)
        e = self.refuse(trust.check_run_dir, "/h/run", platform="linux", euid=1000, lstat=denied)
        self.assertEqual(e.reason, "run-dir-untrusted")

    @unittest.skipUnless(POSIX, "POSIX only")
    def test_a_socket_must_be_a_socket_of_ours(self) -> None:
        ok = st(mode=stat.S_IFSOCK | 0o600)
        trust.check_socket_file("/h/run/core.sock", platform="linux", euid=1000, lstat=lambda p: ok)
        for bad in (st(mode=stat.S_IFSOCK | 0o600, uid=0), st(mode=stat.S_IFREG | 0o600)):
            e = self.refuse(trust.check_socket_file, "/h/run/core.sock", platform="linux", euid=1000, lstat=lambda p, b=bad: b)
            self.assertEqual(e.reason, "socket-untrusted")

    def test_peer_uid_mismatch_is_refused_and_unknown_passes(self) -> None:
        trust.check_peer_uid(1000, 1000)
        trust.check_peer_uid(None, 1000)
        self.assertEqual(self.refuse(trust.check_peer_uid, 0, 1000).reason, "peer-uid-mismatch")

    def test_windows_is_unchanged(self) -> None:
        bad = st(mode=stat.S_IFLNK | 0o777, uid=0)
        trust.check_run_dir("C:\\h\\run", platform="win32", euid=1000, lstat=lambda p: bad)
        trust.verify_address("\\\\.\\pipe\\x", platform="win32", euid=1000, lstat=lambda p: bad)

    def test_a_servers_own_unauthorized_is_not_a_trust_refusal(self) -> None:
        self.assertFalse(is_trust_refusal(RpcError("E_UNAUTHORIZED", "bad token")))


@unittest.skipUnless(POSIX, "POSIX transport")
class ClientTrustTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="p1b-")  # short: AF_UNIX path limit
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.clients: list[MemoryClient] = []
        self.addCleanup(lambda: [c.close() for c in self.clients])
        self.core = FakeCore(self.home).start()
        self.addCleanup(self.core.stop)

    def client(self, **kw) -> MemoryClient:
        c = MemoryClient(self.home, **kw)
        self.clients.append(c)
        return c

    def refused(self, c: MemoryClient, reason: str, connected: bool = False) -> RpcError:
        with mock.patch.object(c, "_read_token", side_effect=AssertionError("the token was read")):
            with self.assertRaises(RpcError) as cm:
                c.connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_UNAUTHORIZED", reason))
        if not connected:  # a peer-uid refusal happens after connect, before anything is sent
            self.assertEqual(self.core.connections, 0, "no connection was made")
        time.sleep(0.05)
        self.assertEqual(self.core.calls, [], "nothing was sent")
        self.assertNotIn(self.core.token, str(cm.exception) + str(cm.exception.data))
        return cm.exception

    def test_happy_path_connects_and_the_real_peer_uid_is_ours(self) -> None:
        hello = self.client().connect()
        self.assertEqual(hello["pid"], self.core.pid)
        s = open_stream(self.core.sock_path, connect_timeout=1.0)
        self.addCleanup(s.close)
        if sys.platform.startswith("linux") or sys.platform == "darwin":
            self.assertEqual(s.peer_uid(), os.geteuid())

    def test_group_writable_run_dir_is_refused_before_the_token_is_read(self) -> None:
        os.chmod(self.core.run, 0o770)
        self.refused(self.client(), "run-dir-untrusted")

    def test_world_writable_run_dir_is_refused(self) -> None:
        os.chmod(self.core.run, 0o777)
        self.refused(self.client(), "run-dir-untrusted")

    def test_symlinked_run_dir_is_refused(self) -> None:
        real = os.path.join(self.home, "real-run")
        os.rename(self.core.run, real)
        os.symlink(real, self.core.run)
        e = self.refused(self.client(), "run-dir-untrusted")
        self.assertIn("symlink", e.data["detail"])

    def test_foreign_owned_run_dir_is_refused(self) -> None:
        # Simulated: the client believes it is another user, so the real (ours) directory is foreign.
        e = self.refused(self.client(euid=os.geteuid() + 1), "run-dir-untrusted")
        self.assertIn("not to this user", e.data["detail"])

    def test_foreign_owned_socket_is_refused(self) -> None:
        real = os.lstat
        sock = self.core.sock_path

        def lstat(p):
            r = real(p)
            return types.SimpleNamespace(st_mode=r.st_mode, st_uid=r.st_uid + 1) if p == sock else r

        self.refused(self.client(lstat=lstat), "socket-untrusted")

    def test_a_non_socket_in_place_of_the_socket_is_refused(self) -> None:
        self.core.stop()
        open(self.core.sock_path, "w").close()
        os.chmod(self.core.sock_path, 0o600)
        self.refused(self.client(), "socket-untrusted")

    def test_peer_uid_mismatch_is_refused_before_the_token_is_sent(self) -> None:
        def factory(address, *, connect_timeout):
            s = open_stream(address, connect_timeout=connect_timeout)
            s.peer_uid = lambda: os.geteuid() + 1  # the kernel names another user as the server
            return s

        self.refused(self.client(transport_factory=factory), "peer-uid-mismatch", connected=True)

    def test_an_unknown_peer_uid_passes(self) -> None:
        def factory(address, *, connect_timeout):
            s = open_stream(address, connect_timeout=connect_timeout)
            s.peer_uid = lambda: None
            return s

        self.assertEqual(self.client(transport_factory=factory).connect()["pid"], self.core.pid)

    def test_a_missing_run_dir_is_still_core_unavailable(self) -> None:
        self.core.stop()
        shutil.rmtree(self.core.run)
        with self.assertRaises(RpcError) as cm:
            self.client().connect()
        self.assertEqual((cm.exception.code, cm.exception.reason), ("E_CORE_UNAVAILABLE", "no-run-dir"))


if __name__ == "__main__":
    unittest.main()
