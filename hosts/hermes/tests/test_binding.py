import hashlib
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest

from tests import FIXTURES_DIR

from plur1bus import binding as binding_mod
from plur1bus._filelock import ExclusiveLockFile, LockTimeout
from plur1bus.binding import (
    BINDING_SCHEMA,
    REGISTRY_SCHEMA,
    Binding,
    BindingConflict,
    BindingInvalid,
    agent_id_for,
    check_binding,
    classify_home,
    default_hermes_root,
    fold_profile,
    read_binding,
    read_registry,
    register_binding,
    registry_add,
    resolve_hermes_home,
    write_binding,
)


def _vectors(name: str) -> dict:
    with open(os.path.join(FIXTURES_DIR, name), encoding="utf-8") as f:
        return json.load(f)


class BindingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="p1h-b-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.default_root = os.path.join(self.root, "u", ".hermes")
        os.makedirs(os.path.join(self.default_root, "profiles"))

    def _dir(self, *parts: str) -> str:
        p = os.path.join(self.root, *parts)
        os.makedirs(p, exist_ok=True)
        return p

    # -- Review Focus 4 ---------------------------------------------------------------------------

    def test_agent_id_folding_and_custom_home_hash(self) -> None:
        r = self.default_root
        ids = lambda home: agent_id_for(home, default_root=r)  # noqa: E731
        self.assertEqual(ids(r), "hermes-default")
        self.assertEqual(ids(self._dir("u", ".hermes", "profiles", "work")), "hermes-work")
        self.assertEqual(ids(self._dir("u", ".hermes", "profiles", "Work.v2")), "hermes-work-v2")
        long_name = "p" * 70
        long_id = ids(self._dir("u", ".hermes", "profiles", long_name))
        self.assertEqual(len(long_id), 64)
        self.assertEqual(long_id, "hermes-" + "p" * 57)
        custom = self._dir("srv", "hermes")
        real = os.path.realpath(custom)
        self.assertEqual(ids(custom), "hermes-home-" + hashlib.sha256(real.encode("utf-8")).hexdigest()[:8])
        # agent_identity is not the key: a home outside the default root reports "default" in Hermes.
        self.assertEqual(agent_id_for(custom, "default", default_root=r), ids(custom))
        self.assertNotEqual(ids(custom), ids(self._dir("srv", "other")))
        # A symlink resolves to the same agent (realpath), including a symlinked default root.
        if hasattr(os, "symlink") and sys.platform != "win32":  # Windows symlinks need a privilege
            link = os.path.join(self.root, "link-to-custom")
            os.symlink(custom, link)
            self.assertEqual(ids(link), ids(custom))
            root_link = os.path.join(self.root, "root-link")
            os.symlink(r, root_link)
            self.assertEqual(agent_id_for(os.path.join(r, "profiles", "work"), default_root=root_link), "hermes-work")
        # The default root comes from HOME when not given.
        self.assertEqual(agent_id_for(r, env={"HOME": os.path.join(self.root, "u")}, platform="linux"), "hermes-default")

    def test_shared_fold_vectors(self) -> None:
        for case in _vectors("binding-vectors.json")["fold"]:
            with self.subTest(profile=case["profile"]):
                self.assertEqual(fold_profile(case["profile"]), case["agentId"])

    def test_shared_classify_vectors(self) -> None:
        for case in _vectors("binding-vectors.json")["classify"]:
            with self.subTest(case=case):
                self.assertEqual(classify_home(case["home"], case["defaultRoot"], case["platform"]), case["agentId"])

    def test_shared_registry_vectors(self) -> None:
        for seq in _vectors("binding-vectors.json")["registry"]:
            with self.subTest(seq=seq["name"]):
                bindings: dict = {}
                for step in seq["steps"]:
                    if step["result"] == "ok":
                        bindings = registry_add(bindings, step["agentId"], step["home"], seq["platform"])
                    else:
                        with self.assertRaises(BindingConflict) as cm:
                            registry_add(bindings, step["agentId"], step["home"], seq["platform"])
                        self.assertEqual(cm.exception.other_home, step["result"]["conflict"])
                        self.assertIn(step["home"], str(cm.exception))
                        self.assertIn(step["result"]["conflict"], str(cm.exception))
                self.assertEqual(bindings, seq["bindings"])

    def test_shared_default_root_vectors(self) -> None:
        for case in _vectors("hermes-home-vectors.json")["cases"]:
            if case["resolvedFrom"] != "default":
                continue
            with self.subTest(case=case):
                env = dict(case["env"])
                if case["platform"] != "win32":
                    env.setdefault("HOME", case["homedir"])
                self.assertEqual(default_hermes_root(env, case["platform"], case["homedir"]), case["root"])

    def test_profile_case_collision_is_refused(self) -> None:
        p1home = self._dir("p")
        upper = self._dir("u", ".hermes", "profiles", "Work")
        lower = self._dir("u", ".hermes", "profiles", "work")
        if os.path.samefile(upper, lower):
            self.skipTest("case-insensitive file system")
        a = agent_id_for(upper, default_root=self.default_root)
        b = agent_id_for(lower, default_root=self.default_root)
        self.assertEqual(a, b, "Work and work fold to one agent id")
        register_binding(p1home, a, upper)
        register_binding(p1home, a, upper)  # idempotent
        with self.assertRaises(BindingConflict) as cm:
            check_binding(p1home, b, lower)
        with self.assertRaises(BindingConflict) as cm:
            register_binding(p1home, b, lower)
        msg = str(cm.exception)
        self.assertIn(os.path.realpath(upper), msg)
        self.assertIn(os.path.realpath(lower), msg)
        self.assertEqual(read_registry(p1home), {"hermes-work": os.path.realpath(upper)})
        with open(os.path.join(p1home, "hosts", "hermes-bindings.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["schema"], REGISTRY_SCHEMA)

    def test_concurrent_registrations_are_all_kept(self) -> None:
        import threading

        p1home = self._dir("p")
        homes = [self._dir("srv", f"h{i}") for i in range(12)]
        errors: list = []

        def reg(i: int) -> None:
            try:
                register_binding(p1home, f"hermes-home-{i:08d}", homes[i])
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=reg, args=(i,)) for i in range(len(homes))]
        for t in threads:
            t.start()
        for t in threads:
            t.join(20)
        self.assertEqual(errors, [])
        self.assertEqual(len(read_registry(p1home)), len(homes), "the registry lock serialises read-modify-write")

    def _lock_path(self, p1home: str) -> str:
        return os.path.join(p1home, "hosts", ".hermes-bindings.lock")

    def _plant_lock(self, p1home: str, pid: int, host: str, age_s: float) -> str:
        path = self._lock_path(p1home)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"{pid} {host} {int(time.time() * 1000)}\n")
        t = time.time() - age_s
        os.utime(path, (t, t))
        return path

    def test_registry_lock_file_blocks_register_until_released(self) -> None:
        p1home = self._dir("p")
        home = self._dir("srv", "h")
        # A live holder (this process, fresh): register_binding must wait, then time out and write nothing.
        path = self._plant_lock(p1home, os.getpid(), socket.gethostname(), 0)
        old = binding_mod.REGISTRY_LOCK_TIMEOUT_S
        binding_mod.REGISTRY_LOCK_TIMEOUT_S = 0.3
        self.addCleanup(setattr, binding_mod, "REGISTRY_LOCK_TIMEOUT_S", old)
        with self.assertRaises(LockTimeout):
            register_binding(p1home, "hermes-x", home)
        self.assertTrue(os.path.exists(path), "a busy lock is not removed by the loser")
        self.assertEqual(read_registry(p1home), {})
        # Released while register_binding waits: it proceeds and removes its own lock afterwards.
        binding_mod.REGISTRY_LOCK_TIMEOUT_S = 5.0
        threading.Timer(0.2, os.unlink, args=(path,)).start()
        register_binding(p1home, "hermes-x", home)
        self.assertEqual(read_registry(p1home), {"hermes-x": os.path.realpath(home)})
        self.assertFalse(os.path.exists(path), "the lock file is removed on release")

    def test_stale_registry_lock_is_broken(self) -> None:
        p1home = self._dir("p")
        home = self._dir("srv", "h")
        # Older than 60 s: broken even though the pid is alive.
        self._plant_lock(p1home, os.getpid(), socket.gethostname(), 61)
        register_binding(p1home, "hermes-a", home)
        self.assertEqual(read_registry(p1home), {"hermes-a": os.path.realpath(home)})
        self.assertFalse(os.path.exists(self._lock_path(p1home)))
        # Garbage content, old: also stale (age rule needs no parse).
        self._plant_lock(p1home, 0, "x", 120)
        with open(self._lock_path(p1home), "w", encoding="utf-8") as f:
            f.write("not a lock")
        os.utime(self._lock_path(p1home), (time.time() - 120,) * 2)
        register_binding(p1home, "hermes-b", home)
        self.assertEqual(len(read_registry(p1home)), 2)
        # A foreign host's fresh lock is never broken by the pid rule.
        self._plant_lock(p1home, 2**22 + 12345, "some-other-host", 5)
        self.assertFalse(ExclusiveLockFile(self._lock_path(p1home))._stale())

    @unittest.skipIf(os.name == "nt", "pid probe is POSIX only")
    def test_dead_pid_lock_of_this_host_is_broken(self) -> None:
        import subprocess

        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        p1home = self._dir("p")
        self._plant_lock(p1home, p.pid, socket.gethostname(), 2)  # >= 1 s old, pid gone
        register_binding(p1home, "hermes-d", self._dir("srv", "h"))
        self.assertIn("hermes-d", read_registry(p1home))

    def test_lock_file_content_and_flags(self) -> None:
        p1home = self._dir("p")
        path = self._lock_path(p1home)
        with ExclusiveLockFile(path).hold(1):
            with open(path, encoding="utf-8") as f:
                pid, host, ms = f.read().split()
            self.assertEqual((int(pid), host), (os.getpid(), socket.gethostname()))
            self.assertLess(abs(int(ms) / 1000 - time.time()), 5)
        self.assertFalse(os.path.exists(path))

    def test_installer_and_provider_lock_protocols_exclude_each_other(self) -> None:
        """A Python transcription of the Node installer's ``withRegistryLock`` (binding.mjs): ``openSync(lock,
        "wx")`` = O_CREAT|O_EXCL, content ``<pid> <hostname> <ms>``, ``rmSync`` on release. It shares nothing with
        ``ExclusiveLockFile`` but the path and the file format, as the real installer does."""

        def js_with_registry_lock(p1home: str, fn, deadline_s: float = 5.0):
            lock = os.path.join(p1home, "hosts", ".hermes-bindings.lock")
            os.makedirs(os.path.dirname(lock), exist_ok=True)
            end = time.monotonic() + deadline_s
            while True:
                try:
                    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    break
                except FileExistsError:
                    if time.monotonic() > end:
                        raise RuntimeError("the bindings registry is locked")
                    time.sleep(0.025)
            try:
                os.write(fd, f"{os.getpid()} {socket.gethostname()} {int(time.time() * 1000)}\n".encode())
                return fn()
            finally:
                os.close(fd)
                try:
                    os.unlink(lock)
                except FileNotFoundError:
                    pass

        p1home = self._dir("p")
        path = self._lock_path(p1home)
        # 1. The installer holds it: the provider's lock times out.
        def provider_while_installer_holds() -> None:
            with self.assertRaises(LockTimeout):
                with ExclusiveLockFile(path).hold(0.2):
                    self.fail("provider entered while the installer held the lock")

        js_with_registry_lock(p1home, provider_while_installer_holds)
        self.assertFalse(os.path.exists(path))
        # 2. The provider holds it: the installer's deadline expires.
        with ExclusiveLockFile(path).hold(1):
            with self.assertRaises(RuntimeError):
                js_with_registry_lock(p1home, lambda: self.fail("installer entered while the provider held the lock"), 0.2)
        self.assertFalse(os.path.exists(path))
        # 3. Interleaved read-modify-write of one counter from both sides loses no update.
        counter = os.path.join(p1home, "counter")
        with open(counter, "w", encoding="utf-8") as f:
            f.write("0")

        def bump() -> None:
            with open(counter, encoding="utf-8") as f:
                n = int(f.read())
            time.sleep(0.002)
            with open(counter, "w", encoding="utf-8") as f:
                f.write(str(n + 1))

        def provider_side() -> None:
            for _ in range(15):
                with ExclusiveLockFile(path).hold(10):
                    bump()

        def installer_side() -> None:
            for _ in range(15):
                js_with_registry_lock(p1home, bump, 10)

        threads = [threading.Thread(target=provider_side), threading.Thread(target=installer_side)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        with open(counter, encoding="utf-8") as f:
            self.assertEqual(f.read(), "30")

    def test_binding_written_atomically_0600(self) -> None:
        home = self._dir("h")
        b = Binding(home="/opt/p1b", agent_id="hermes-work", bin="/usr/local/bin/plur1bus", version="0.1.0", installed_by="installer")
        write_binding(home, b)
        path = os.path.join(home, "plur1bus.json")
        if os.name == "posix":
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertEqual([n for n in os.listdir(home) if ".tmp-" in n], [])
        self.assertEqual(read_binding(home), b)
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        self.assertEqual(
            doc,
            {
                "schema": BINDING_SCHEMA,
                "version": "0.1.0",
                "installedBy": "installer",
                "home": "/opt/p1b",
                "bin": "/usr/local/bin/plur1bus",
                "agentId": "hermes-work",
                "recallHardMs": 600,
                "capture": True,
            },
        )
        write_binding(home, b.with_(capture=False))
        self.assertFalse(read_binding(home).capture)
        self.assertIsNone(read_binding(self._dir("empty")))

    def test_invalid_binding_is_refused(self) -> None:
        home = self._dir("h")
        path = os.path.join(home, "plur1bus.json")
        good = Binding(home="/opt/p1b", agent_id="hermes-work").to_json()
        for bad in (
            "nope",
            json.dumps([1]),
            json.dumps({**good, "schema": "other/1"}),
            json.dumps({**good, "home": "relative/path"}),
            json.dumps({**good, "agentId": "Hermes Work"}),
            json.dumps({**good, "recallHardMs": 5}),
            json.dumps({**good, "capture": "yes"}),
            json.dumps({**good, "version": 3}),
        ):
            with open(path, "w", encoding="utf-8") as f:
                f.write(bad)
            with self.subTest(bad=bad), self.assertRaises(BindingInvalid):
                read_binding(home)
        with self.assertRaises(BindingInvalid):
            write_binding(home, Binding(home="rel", agent_id="hermes-x"))

    def test_resolve_hermes_home_order(self) -> None:
        self.assertEqual(resolve_hermes_home("/x/y"), os.path.abspath("/x/y"))
        installed = os.path.join(self.root, "hh", "plugins", "plur1bus", "__init__.py")
        self.assertEqual(resolve_hermes_home(module_file=installed, env={"HERMES_HOME": "/elsewhere"}), os.path.join(self.root, "hh"))
        dev = os.path.join(self.root, "hosts", "hermes", "plur1bus", "__init__.py")
        self.assertEqual(resolve_hermes_home(module_file=dev, env={"HERMES_HOME": "/elsewhere"}), os.path.abspath("/elsewhere"))
        self.assertEqual(resolve_hermes_home(module_file=dev, env={"HOME": "/home/u"}, platform="linux"), "/home/u/.hermes")


if __name__ == "__main__":
    unittest.main()
