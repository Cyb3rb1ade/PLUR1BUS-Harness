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
from plur1bus._filelock import ExclusiveLockFile, LockLost, LockTimeout
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
        def unlink_retrying() -> None:  # Windows: a waiter's open() makes a plain unlink fail with a sharing error
            for _ in range(200):
                try:
                    os.unlink(path)
                    return
                except PermissionError:
                    time.sleep(0.01)

        threading.Timer(0.2, unlink_retrying).start()
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
        self.assertIsNone(ExclusiveLockFile(self._lock_path(p1home))._judge_stale())

    def test_dead_pid_lock_of_this_host_is_broken(self) -> None:
        import subprocess

        # The Popen object keeps the process handle open on Windows: the probe must still see it exited.
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        p1home = self._dir("p")
        self._plant_lock(p1home, p.pid, socket.gethostname(), 2)  # >= 1 s old, pid gone
        old = binding_mod.REGISTRY_LOCK_TIMEOUT_S
        binding_mod.REGISTRY_LOCK_TIMEOUT_S = 5.0  # well below the 60 s age rule: only the pid rule can break it
        self.addCleanup(setattr, binding_mod, "REGISTRY_LOCK_TIMEOUT_S", old)
        register_binding(p1home, "hermes-d", self._dir("srv", "h"))
        self.assertIn("hermes-d", read_registry(p1home))
        # A live pid of this host (this process) and a pid Node would reject are never judged dead.
        lock = ExclusiveLockFile(self._lock_path(p1home))
        self._plant_lock(p1home, os.getpid(), socket.gethostname(), 2)
        self.assertIsNone(lock._judge_stale())
        self._plant_lock(p1home, 2**40, socket.gethostname(), 2)
        self.assertIsNone(lock._judge_stale())
        # Younger than 1 s: the dead pid is not enough yet.
        self._plant_lock(p1home, p.pid, socket.gethostname(), 0)
        self.assertIsNone(lock._judge_stale())

    def test_release_never_raises_when_the_moved_file_cannot_be_removed(self) -> None:
        p1home = self._dir("p")
        path = self._lock_path(p1home)
        lock = ExclusiveLockFile(path)

        def failing_unlink(_p: str) -> None:
            raise PermissionError(13, "denied")

        lock._unlink = failing_unlink  # type: ignore[method-assign]
        # Own nonce -> unlink fails: the body's exception is not masked, and nothing escapes on success.
        with self.assertRaises(ValueError):
            with lock.hold(1):
                raise ValueError("body")
        with lock.hold(1):
            pass
        # Foreign nonce (stolen) -> put-back path; its unlink fails too: still no exception, the new lock stays.
        foreign = f"4242 {socket.gethostname()} {int(time.time() * 1000)} {'ab' * 16}\n"
        with lock.hold(1):
            os.unlink(path)
            with open(path, "w", encoding="utf-8") as f:
                f.write(foreign)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), foreign)
        self.assertTrue(any(".rel-" in n for n in os.listdir(os.path.dirname(path))), "left to the sweep")

    def test_failed_break_waits_and_times_out(self) -> None:
        p1home = self._dir("p")
        path = self._lock_path(p1home)
        self._plant_lock(p1home, 1, "h", 120)
        lock = ExclusiveLockFile(path)
        calls = []

        def failing_break(*a):
            calls.append(a)
            return False  # e.g. the rename keeps failing

        lock._break = failing_break  # type: ignore[method-assign]
        start = time.monotonic()
        with self.assertRaises(LockTimeout):
            with lock.hold(0.3):
                self.fail("entered a lock that could not be broken")
        elapsed = time.monotonic() - start
        self.assertLess(elapsed, 2.0)
        self.assertLess(len(calls), 0.3 / ExclusiveLockFile.POLL_S + 3, "a failed break sleeps one poll, no spin")
        self.assertTrue(os.path.exists(path))

    @unittest.skipUnless(os.name == "nt", "sharing violations exist on Windows only")
    def test_release_retries_while_a_reader_holds_the_lock_file_open(self) -> None:
        p1home = self._dir("p")
        path = self._lock_path(p1home)
        opened, done = threading.Event(), threading.Event()

        def reader() -> None:
            with open(path, "rb"):  # CPython opens without FILE_SHARE_DELETE: the rename fails meanwhile
                opened.set()
                time.sleep(0.3)
            done.set()

        with ExclusiveLockFile(path).hold(1):
            threading.Thread(target=reader).start()
            self.assertTrue(opened.wait(5))
        self.assertTrue(done.is_set(), "the release waited for the reader")
        self.assertFalse(os.path.exists(path), "the lock is gone after the retried release")
        self.assertEqual([n for n in os.listdir(os.path.dirname(path)) if ".rel-" in n], [])

    def test_lock_file_content_and_flags(self) -> None:
        p1home = self._dir("p")
        path = self._lock_path(p1home)
        with ExclusiveLockFile(path).hold(1):
            with open(path, encoding="utf-8") as f:
                pid, host, ms, nonce = f.read().split()
            self.assertEqual((int(pid), host), (os.getpid(), socket.gethostname()))
            self.assertRegex(nonce, r"^[0-9a-f]{32}$")
            self.assertLess(abs(int(ms) / 1000 - time.time()), 5)
        self.assertFalse(os.path.exists(path))

    def test_basic_o_excl_exclusion_against_a_transcription_of_the_installer_lock(self) -> None:
        """Only the basic O_EXCL exclusion and the stolen-lock release, against a Python transcription of the
        Node installer's ``withRegistryLock`` (binding.mjs): ``openSync(lock, "wx")``, content ``<pid> <hostname>
        <ms> <nonce>``, release by rename to ``<lock>.rel-<nonce>`` and unlink only when the nonce is ours. It
        shares nothing with ``ExclusiveLockFile`` but the path and the format, and has no stale or break path. A
        real cross-language test (Node and Python workers on one lock, dying holders) is a plugin-repo follow-up."""

        def js_with_registry_lock(p1home: str, fn, deadline_s: float = 5.0):
            lock = os.path.join(p1home, "hosts", ".hermes-bindings.lock")
            os.makedirs(os.path.dirname(lock), exist_ok=True)
            nonce = os.urandom(16).hex()
            end = time.monotonic() + deadline_s
            while True:
                try:
                    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    break
                except (FileExistsError, PermissionError) as e:
                    if isinstance(e, PermissionError) and os.name != "nt":  # win32: EPERM/EACCES = busy
                        raise
                    if time.monotonic() > end:
                        raise RuntimeError("the bindings registry is locked")
                    time.sleep(0.025)
            os.write(fd, f"{os.getpid()} {socket.gethostname()} {int(time.time() * 1000)} {nonce}\n".encode())
            os.close(fd)
            try:
                return fn()
            finally:
                rel = f"{lock}.rel-{nonce}"
                give_up = time.monotonic() + 2.0
                while True:  # the release-rename retry the installer must mirror (I1): sharing errors on win32
                    try:
                        os.rename(lock, rel)
                        break
                    except FileNotFoundError:
                        return
                    except PermissionError:
                        if os.name != "nt" or time.monotonic() >= give_up:
                            raise
                        time.sleep(0.01)
                with open(rel, encoding="utf-8") as f:  # closed before the unlink (Windows sharing)
                    ours = f.read().split()[3] == nonce
                if not ours:
                    try:
                        os.link(rel, lock)
                    except FileExistsError:
                        pass
                os.unlink(rel)

        p1home = self._dir("p")
        path = self._lock_path(p1home)

        def provider_while_installer_holds() -> None:
            with self.assertRaises(LockTimeout):
                with ExclusiveLockFile(path).hold(0.2):
                    self.fail("provider entered while the installer held the lock")

        js_with_registry_lock(p1home, provider_while_installer_holds)
        self.assertFalse(os.path.exists(path))
        with ExclusiveLockFile(path).hold(1):
            with self.assertRaises(RuntimeError):
                js_with_registry_lock(p1home, lambda: self.fail("installer entered while the provider held the lock"), 0.2)
        self.assertFalse(os.path.exists(path))
        counter = os.path.join(p1home, "counter")
        with open(counter, "w", encoding="utf-8") as f:
            f.write("0")

        def bump() -> None:
            with open(counter, encoding="utf-8") as f:
                n = int(f.read())
            time.sleep(0.002)
            with open(counter, "w", encoding="utf-8") as f:
                f.write(str(n + 1))

        errors: list[BaseException] = []

        def provider_side() -> None:
            try:
                for _ in range(15):
                    with ExclusiveLockFile(path).hold(10):
                        bump()
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        def installer_side() -> None:
            try:
                for _ in range(15):
                    js_with_registry_lock(p1home, bump, 10)
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=provider_side), threading.Thread(target=installer_side)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        self.assertEqual(errors, [])
        with open(counter, encoding="utf-8") as f:
            self.assertEqual(f.read(), "30")
        # Each side honours the other's stolen-lock rule: a lock holding a foreign nonce survives our release.
        with ExclusiveLockFile(path).hold(1):
            os.unlink(path)
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"1 {socket.gethostname()} {int(time.time() * 1000)} {'ab' * 16}\n")
        with open(path, encoding="utf-8") as f:
            self.assertIn("ab" * 16, f.read())
        self.assertEqual([n for n in os.listdir(os.path.dirname(path)) if ".rel-" in n], [])

    def test_stolen_lock_is_not_released_by_the_old_holder(self) -> None:
        p1home = self._dir("p")
        path = self._lock_path(p1home)
        foreign = f"4242 {socket.gethostname()} {int(time.time() * 1000)} {'cd' * 16}\n"
        with ExclusiveLockFile(path).hold(1):
            os.unlink(path)  # broken and re-taken by someone else
            with open(path, "w", encoding="utf-8") as f:
                f.write(foreign)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), foreign, "the new owner's lock survives the old holder's release")
        self.assertEqual([n for n in os.listdir(os.path.dirname(path)) if ".rel-" in n or ".break-" in n], [])

    def test_break_puts_back_a_lock_that_is_not_the_one_judged_stale(self) -> None:
        p1home = self._dir("p")
        path = self._lock_path(p1home)
        self._plant_lock(p1home, 1, "h", 120)
        lock = ExclusiveLockFile(path)
        judged = lock._judge_stale()
        self.assertIsNotNone(judged)
        # Someone else breaks it and takes a fresh lock before we rename.
        os.unlink(path)
        fresh = f"{os.getpid()} {socket.gethostname()} {int(time.time() * 1000)} {'ef' * 16}\n"
        with open(path, "w", encoding="utf-8") as f:
            f.write(fresh)
        lock._break(*judged)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), fresh, "the fresh lock is put back")
        self.assertEqual([n for n in os.listdir(os.path.dirname(path)) if ".break-" in n], [])
        # Put-back never overwrites a newer lock: EEXIST drops the moved file only.
        moved = path + ".break-x"
        with open(moved, "w", encoding="utf-8") as f:
            f.write("old\n")
        lock._restore(moved)
        self.assertFalse(os.path.exists(moved))
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), fresh)

    def test_lock_lost_before_the_write_writes_nothing(self) -> None:
        p1home = self._dir("p")
        home = self._dir("srv", "h")
        path = self._lock_path(p1home)
        real_add = binding_mod.registry_add

        def stealing_add(*a, **kw):
            out = real_add(*a, **kw)
            os.unlink(path)  # judged stale and taken over while we were reading
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"4242 {socket.gethostname()} {int(time.time() * 1000)} {'12' * 16}\n")
            return out

        binding_mod.registry_add = stealing_add
        try:
            with self.assertRaises(LockLost):
                register_binding(p1home, "hermes-l", home)
        finally:
            binding_mod.registry_add = real_add
        self.assertEqual(read_registry(p1home), {})
        self.assertFalse(os.path.exists(os.path.join(p1home, "hosts", "hermes-bindings.json")))
        with open(path, encoding="utf-8") as f:
            self.assertIn("12" * 16, f.read())

    def test_old_break_and_rel_leftovers_are_swept(self) -> None:
        p1home = self._dir("p")
        path = self._lock_path(p1home)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        old, new = path + ".break-old", path + ".rel-new"
        for n in (old, new):
            with open(n, "w", encoding="utf-8") as f:
                f.write("x")
        os.utime(old, (time.time() - 120,) * 2)
        with ExclusiveLockFile(path).hold(1):
            pass
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(new))

    def test_multiprocess_stress_no_double_entry_even_when_holders_die(self) -> None:
        import subprocess

        p1home = self._dir("p")
        path = self._lock_path(p1home)
        log = os.path.join(p1home, "cs.log")
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_lock_worker.py")
        # 5 workers x 12 sections; two of them die while holding (a dead pid of this host is broken after 1 s).
        die_at = [-1, -1, -1, 4, 8]
        procs = [subprocess.Popen([sys.executable, worker, path, log, "12", str(d)]) for d in die_at]
        reapers = [threading.Thread(target=p.wait) for p in procs]  # no zombies: kill(pid, 0) must see them dead
        for t in reapers:
            t.start()
        for t in reapers:
            t.join(90)
        for p in procs:
            if p.returncode is None:
                p.kill()  # bounded: never leave a worker behind on failure
        self.assertTrue(all(p.returncode == 0 for p in procs), [p.returncode for p in procs])
        # The accepted put-back window: a waiter that judged a dead holder's lock stale can rename a fresh live lock
        # aside (and put it back); a third process may enter meanwhile. The protocol's guarantee is that then the
        # displaced holder's verify() fails (L) and it writes nothing. So an overlap is allowed only when every
        # holder already inside logs L before its X.
        inside: list[str] = []
        must_lose: set[str] = set()
        refused: set[str] = set()  # logged L in its current section: it writes nothing, never re-flagged
        entries = deaths = lost = 0
        with open(log, encoding="utf-8") as f:
            for line in f:
                tag, pid = line.split()
                if tag == "E":
                    must_lose.update(h for h in inside if h not in refused)
                    inside.append(pid)
                    entries += 1
                elif tag in ("X", "D"):
                    self.assertIn(pid, inside)
                    if tag == "X":  # a dying holder (D) writes nothing either way
                        self.assertNotIn(pid, must_lose, f"double entry: {pid} overlapped another holder and verified")
                    must_lose.discard(pid)
                    refused.discard(pid)
                    inside.remove(pid)
                    deaths += tag == "D"
                elif tag == "L":
                    self.assertIn(pid, inside)  # verify() refused the write: safe
                    must_lose.discard(pid)
                    refused.add(pid)
                    lost += 1
                else:
                    self.fail(f"unexpected log entry {line!r}")
        self.assertEqual(inside, [])
        self.assertEqual(deaths, 2)
        self.assertLessEqual(lost, 4 * deaths, "only a break of a dead holder's lock can displace a live lock")
        self.assertEqual(entries, 3 * 12 + 5 + 9, "every section ran exactly once (dying workers stop at their death)")

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
