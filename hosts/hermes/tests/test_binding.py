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


def _lock_timeout_diagnostics(path: str, side: str, last_holder: str | None) -> dict:
    def valid_nonce(value: str) -> bool:
        return len(value) == 32 and all(c in "0123456789abcdef" for c in value)

    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            parts = f.read().split()
        pid = parts[0] if parts and parts[0].isascii() and parts[0].isdigit() else None
        token = {
            "pid": pid,
            "nonce": parts[3] if len(parts) >= 4 and valid_nonce(parts[3]) else None,
            # who owns it and how old it is: the two facts that tell a live holder from an ownerless leftover
            "owner": None if pid is None else ("this-process" if int(pid) == os.getpid() else "other"),
            "age_s": max(0, int(time.time() - os.stat(path).st_mtime)),
        }
    except OSError as e:
        token = {"state": type(e).__name__}
    base = os.path.basename(path)
    prefixes = (base + ".rel-", base + ".break-")
    try:
        moved = []
        for name in os.listdir(os.path.dirname(path)):
            for prefix in prefixes:
                if name.startswith(prefix):
                    suffix = name[len(prefix):]
                    moved.append(prefix + (suffix if valid_nonce(suffix) else "<redacted>"))
        moved.sort()
    except OSError as e:
        moved = [type(e).__name__]
    return {"timeout_side": side, "lock": token, "moved": moved, "last_holder": last_holder}


# A Python transcription of the Node installer's registry lock (PLUR1BUS-Host-Addons
# scripts/dist/installer/hermes/binding.mjs: withRegistryLock, releaseLock, settle, movedAside). It shares nothing
# with ExclusiveLockFile but the path and the token format. The acquire omits the installer's stale/break path (the
# exclusion test below needs only the O_EXCL exclusion); the release mirrors releaseLock in full, including the
# put-back wait on ENOENT (settle, Host-Addons 954729b), so a lock a waiter moved aside is not abandoned.
_JS_RELEASE_RETRY_S = 2.0
_JS_SETTLE_POLL_S = 0.005


def _js_read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _js_holds(text: str | None, nonce: str) -> bool:
    parts = (text or "").split()
    return len(parts) >= 4 and parts[3] == nonce


def _js_moved_aside(lock: str, nonce: str) -> bool:
    d, base = os.path.split(lock)
    try:
        names = os.listdir(d)
    except OSError:
        return False
    return any(
        n.startswith((base + ".break-", base + ".rel-")) and _js_holds(_js_read(os.path.join(d, n)), nonce)
        for n in names
    )


def _js_settle(lock: str, nonce: str, budget_s: float) -> bool:
    deadline = time.monotonic() + budget_s
    while True:
        if _js_holds(_js_read(lock), nonce):
            return True
        if not _js_moved_aside(lock, nonce):
            return _js_holds(_js_read(lock), nonce)
        if time.monotonic() >= deadline:
            return False
        time.sleep(_JS_SETTLE_POLL_S)


def _js_acquire(p1home: str, deadline_s: float = 5.0) -> tuple[str, str]:
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
    return lock, nonce


def _js_release(lock: str, nonce: str) -> None:
    """releaseLock: rename to ``<lock>.rel-<nonce>`` (win32 sharing errors retried); on ENOENT wait for a pending
    put-back of our lock (settle) and retry, else it was broken and nothing of ours is left; unlink the moved file
    only when it holds our nonce, else put it back (a stolen lock is never deleted)."""
    rel = f"{lock}.rel-{nonce}"
    deadline = time.monotonic() + _JS_RELEASE_RETRY_S
    while True:
        try:
            os.rename(lock, rel)
            break
        except FileNotFoundError:
            if not _js_settle(lock, nonce, max(0.0, deadline - time.monotonic())) or time.monotonic() >= deadline:
                return
        except PermissionError:
            if os.name != "nt" or time.monotonic() >= deadline:
                raise
            time.sleep(0.01)
    text = _js_read(rel)  # closed before the unlink (Windows sharing)
    if _js_holds(text, nonce):
        os.unlink(rel)
    elif text is not None:
        try:
            os.link(rel, lock)
        except FileExistsError:
            pass
        os.unlink(rel)


def _js_with_registry_lock(p1home: str, fn, deadline_s: float = 5.0):
    lock, nonce = _js_acquire(p1home, deadline_s)
    try:
        return fn()
    finally:
        _js_release(lock, nonce)


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

    def test_lock_timeout_diagnostics_are_redacted_and_tolerate_missing_files(self) -> None:
        path = self._lock_path(self._dir("p"))
        self.assertEqual(
            _lock_timeout_diagnostics(path, "provider", None),
            {"timeout_side": "provider", "lock": {"state": "FileNotFoundError"},
             "moved": ["FileNotFoundError"], "last_holder": None},
        )
        nonce = "ab" * 16
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"123 private-host 123456 {nonce}\n")
        for suffix in (f".rel-{nonce}", f".break-{nonce}", ".rel-private-host"):
            with open(path + suffix, "w", encoding="utf-8") as f:
                f.write("private content")
        snapshot = _lock_timeout_diagnostics(path, "provider", "installer")
        self.assertIsInstance(snapshot["lock"].pop("age_s"), int)
        self.assertEqual(snapshot, {
            "timeout_side": "provider", "lock": {"pid": "123", "nonce": nonce, "owner": "other"},
            "moved": [f".hermes-bindings.lock.break-{nonce}", ".hermes-bindings.lock.rel-<redacted>",
                      f".hermes-bindings.lock.rel-{nonce}"],
            "last_holder": "installer",
        })
        with open(path, "w", encoding="utf-8") as f:
            f.write("private-pid private-host 123456 private-nonce\n")
        snapshot = _lock_timeout_diagnostics(path, "installer", "provider")
        self.assertIsInstance(snapshot["lock"].pop("age_s"), int)
        self.assertEqual(snapshot["lock"], {"pid": None, "nonce": None, "owner": None})
        self.assertNotIn("private", json.dumps(snapshot))
        self.assertNotIn(self.root, json.dumps(snapshot))

    def test_transcription_timeout_includes_diagnostics(self) -> None:
        from unittest.mock import patch

        original_hold = ExclusiveLockFile.hold

        def hold(lock, timeout):
            if timeout == 10:
                raise LockTimeout("injected timeout")
            return original_hold(lock, timeout)

        case = BindingTest("test_basic_o_excl_exclusion_against_a_transcription_of_the_installer_lock")
        result = unittest.TestResult()
        with patch.object(ExclusiveLockFile, "hold", hold):
            case.run(result)
        self.assertEqual(result.errors, [])
        self.assertEqual(len(result.failures), 1)
        message = result.failures[0][1]
        self.assertIn("injected timeout", message)
        self.assertIn('"timeout_side": "provider"', message)
        self.assertIn('"last_holder":', message)
        self.assertNotIn(case.root, message)
        self.assertNotIn(socket.gethostname(), message)

    def test_installer_release_waits_for_the_put_back_of_a_lock_a_break_moved_aside(self) -> None:
        """Issue #75 candidate. A waiter judged the installer's first lock stale; the installer then released it and
        took a fresh one, and the waiter's ``_break`` renamed that fresh lock aside (dev/inode differ -> ``_restore``
        puts it back with ``os.link``). The installer's release rename runs while it is aside and finds nothing; it
        must wait for the put-back and release it (binding.mjs ``releaseLock`` -> ``settle``), not return and leave a
        live-pid lock nobody owns until the 60 s stale rule. The release is driven to its ENOENT before the put-back
        link runs, so the interleaving is forced, not timed."""
        from unittest import mock

        p1home = self._dir("p")
        path = self._lock_path(p1home)
        lock, first = _js_acquire(p1home)
        with open(path, encoding="utf-8") as f:
            judged = (os.stat(path), f.read())  # what the waiter judged stale
        _js_release(lock, first)
        lock, second = _js_acquire(p1home)  # the fresh lock the break moves aside by mistake
        real_rename, real_link = os.rename, os.link
        release_saw_enoent = threading.Event()
        release_thread: list[threading.Thread] = []

        def rename(src, dst, *a, **kw):
            try:
                return real_rename(src, dst, *a, **kw)
            except FileNotFoundError:
                if str(dst).endswith(".rel-" + second):
                    release_saw_enoent.set()
                raise

        def link_after_the_release_found_the_lock_gone(src, dst, *a, **kw):
            if not release_thread:  # the put-back: first let the installer's release hit the moved-aside window
                t = threading.Thread(target=_js_release, args=(lock, second), daemon=True)
                release_thread.append(t)
                t.start()
                self.assertTrue(release_saw_enoent.wait(5), "the release rename ran while the lock was aside")
            return real_link(src, dst, *a, **kw)

        with mock.patch.object(os, "rename", rename), mock.patch.object(os, "link", link_after_the_release_found_the_lock_gone):
            self.assertFalse(ExclusiveLockFile(path)._break(*judged))
            release_thread[0].join(5)
        self.assertFalse(release_thread[0].is_alive())
        self.assertEqual(os.listdir(os.path.dirname(path)), [], "the installer released its put-back lock")
        with ExclusiveLockFile(path).hold(0.3):
            pass

    def test_basic_o_excl_exclusion_against_a_transcription_of_the_installer_lock(self) -> None:
        """Only the basic O_EXCL exclusion and the stolen-lock release, against the Python transcription of the
        Node installer's ``withRegistryLock`` (binding.mjs; ``_js_with_registry_lock`` above): ``openSync(lock, "wx")``,
        content ``<pid> <hostname> <ms> <nonce>``, release by rename to ``<lock>.rel-<nonce>`` and unlink only when the
        nonce is ours. It shares nothing with ``ExclusiveLockFile`` but the path and the format; its acquire has no
        stale or break path. The real cross-language tests (Node and Python workers on one lock, dying holders) are in
        PLUR1BUS-Host-Addons (tests/dist-hermes-lock-interop.test.js)."""

        js_with_registry_lock = _js_with_registry_lock

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

        last_holder: list[str | None] = [None]

        def bump(side: str) -> None:
            last_holder[0] = side
            with open(counter, encoding="utf-8") as f:
                n = int(f.read())
            time.sleep(0.002)
            with open(counter, "w", encoding="utf-8") as f:
                f.write(str(n + 1))

        errors: list[BaseException] = []
        diagnostics: list[dict] = []

        def provider_side() -> None:
            try:
                for _ in range(15):
                    with ExclusiveLockFile(path).hold(10):
                        bump("provider")
            except BaseException as e:  # noqa: BLE001
                if isinstance(e, LockTimeout):
                    diagnostics.append(_lock_timeout_diagnostics(path, "provider", last_holder[0]))
                errors.append(e)

        def installer_side() -> None:
            try:
                for _ in range(15):
                    js_with_registry_lock(p1home, lambda: bump("installer"), 10)
            except BaseException as e:  # noqa: BLE001
                if isinstance(e, RuntimeError):
                    diagnostics.append(_lock_timeout_diagnostics(path, "installer", last_holder[0]))
                errors.append(e)

        threads = [threading.Thread(target=provider_side), threading.Thread(target=installer_side)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        alive = [t.name for t in threads if t.is_alive()]
        if alive:  # a hang is reported with the lock's state too, not just as a wrong counter below
            diagnostics.append(_lock_timeout_diagnostics(path, "hang:" + ",".join(alive), last_holder[0]))
        self.assertEqual(alive, [], json.dumps(diagnostics, sort_keys=True))
        self.assertEqual(errors, [], json.dumps(diagnostics, sort_keys=True))
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

    def test_a_forward_clock_step_never_leaves_an_ownerless_lock(self) -> None:
        """Issue #75, the one trigger the analysis left: both tokens carry a live pid, so a waiter judges the
        installer's lock stale only when ``time.time()`` steps forward by more than ``STALE_S`` (an NTP or VM-resume
        step on a CI runner). That is a *double entry* (the stale rule, by design), but it must never end in a
        ``LockTimeout``: the break unlinks the judged file, the installer's release finds it gone, settles (nothing
        moved aside holds its nonce) and returns, and no lock is left that nobody owns. Driven with a stepped clock,
        not with sleeps."""
        from unittest import mock

        p1home = self._dir("p")
        path = self._lock_path(p1home)
        lock, nonce = _js_acquire(p1home)  # the installer holds it, fresh
        real_time = time.time
        with mock.patch.object(time, "time", lambda: real_time() + ExclusiveLockFile.STALE_S + 1):
            with ExclusiveLockFile(path).hold(1):  # the waiter judges the live lock stale and breaks it
                entered_while_the_installer_still_holds = True
        self.assertTrue(entered_while_the_installer_still_holds)
        _js_release(lock, nonce)  # the installer's release: ENOENT, settle finds nothing, nothing of ours is left
        self.assertEqual(os.listdir(os.path.dirname(path)), [], "no lock, break or release file is left behind")
        with ExclusiveLockFile(path).hold(0.3):  # and the next holder is not locked out
            pass

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

    def test_register_binding_verifies_immediately_before_replace(self) -> None:
        """FR-L1 (ii): a steal after the read, at the start of the publishing write, must still
        refuse. That only holds when ``held.verify`` is the ``before_replace`` hook, not a
        separate call before ``atomic_write_text``."""
        p1home = self._dir("p")
        home = self._dir("srv", "h")
        path = self._lock_path(p1home)
        real = binding_mod.atomic_write_text
        seen: dict = {}

        def steal_then_write(*a, **kw):
            seen["before_replace"] = kw.get("before_replace")
            os.unlink(path)
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"4242 {socket.gethostname()} {int(time.time() * 1000)} {'12' * 16}\n")
            return real(*a, **kw)

        binding_mod.atomic_write_text = steal_then_write
        try:
            with self.assertRaises(LockLost):
                register_binding(p1home, "hermes-l", home)
        finally:
            binding_mod.atomic_write_text = real
        self.assertTrue(callable(seen.get("before_replace")), "register_binding must pass before_replace=held.verify")
        self.assertEqual(read_registry(p1home), {})
        self.assertFalse(os.path.exists(os.path.join(p1home, "hosts", "hermes-bindings.json")))
        self.assertEqual([n for n in os.listdir(os.path.join(p1home, "hosts")) if ".tmp-" in n], [])
        with open(path, encoding="utf-8") as f:
            self.assertIn("12" * 16, f.read())

    def test_displaced_holder_refuses_publishing_replace(self) -> None:
        """Analogous to Host-Addons tests/dist-hermes-lock-fr-l1.test.js: the holder prepares,
        the lock is moved aside, a newcomer takes it, then the holder publishes through
        register_binding's write path (atomic_write_text + held.verify)."""
        import subprocess

        p1home = self._dir("p")
        path = self._lock_path(p1home)
        registry = os.path.join(p1home, "hosts", "hermes-bindings.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        original = json.dumps({"schema": REGISTRY_SCHEMA, "bindings": {"keep": "/old"}}, indent=2) + "\n"
        published = json.dumps(
            {"schema": REGISTRY_SCHEMA, "bindings": {"holder-agent": "/tmp/holder-home"}}, indent=2
        ) + "\n"
        flag = os.path.join(p1home, "newcomer-in")
        release = os.path.join(p1home, "release")
        filelock_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plur1bus", "_filelock.py")
        newcomer = r"""
import importlib.util, os, sys, time
lock_path, flag, release, filelock_py = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
spec = importlib.util.spec_from_file_location("p1_filelock", filelock_py)
mod = importlib.util.module_from_spec(spec)
sys.modules["p1_filelock"] = mod
spec.loader.exec_module(mod)
with mod.ExclusiveLockFile(lock_path).hold(30):
    with open(flag, "w", encoding="utf-8") as f:
        f.write("in")
    for _ in range(400):
        if os.path.exists(release):
            break
        time.sleep(0.025)
"""
        proc = None
        with ExclusiveLockFile(path).hold(30) as held:
            with open(registry, "w", encoding="utf-8") as f:
                f.write(original)
            moved = path + ".break-" + ("e" * 32)
            os.rename(path, moved)
            proc = subprocess.Popen(
                [sys.executable, "-c", newcomer, path, flag, release, filelock_py],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.addCleanup(lambda p=proc: p.kill() if p.poll() is None else None)
            for _ in range(400):
                if os.path.exists(flag):
                    break
                time.sleep(0.025)
            self.assertTrue(os.path.exists(flag), "the newcomer is inside")
            with self.assertRaises(FileExistsError):
                os.link(moved, path)
            os.unlink(moved)
            with self.assertRaises(LockLost):
                binding_mod.atomic_write_text(registry, published, before_replace=held.verify)
            with open(release, "w", encoding="utf-8") as f:
                f.write("1")
            self.assertEqual(proc.wait(20), 0)
        with open(registry, encoding="utf-8") as f:
            self.assertEqual(f.read(), original, "displaced holder did not publish")
        self.assertEqual(read_registry(p1home), {"keep": "/old"})
        self.assertEqual([n for n in os.listdir(os.path.dirname(registry)) if ".tmp-" in n], [])

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
                if line.startswith("T "):
                    _, pid, exception, code = line.split()
                    self.fail(f"lock worker {pid} failed: {exception} (winerror/errno={code})")
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
                elif tag == "W":
                    self.assertIn(pid, inside)
                    self.assertNotIn(pid, must_lose, f"double entry: {pid} overlapped another holder and published")
                    self.assertNotIn(pid, refused)
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


class BindingAuditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="p1b-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_write_tools_default_off_and_round_trip(self) -> None:
        self.assertFalse(Binding(home="/opt/p1b", agent_id="hermes-x").memory_write_tools)
        doc = Binding(home="/opt/p1b", agent_id="hermes-x").to_json()
        self.assertNotIn("memoryWriteTools", doc, "off is the absent field")
        self.assertFalse(Binding.from_json(doc).memory_write_tools, "an older file without the field means off")
        on = Binding(home="/opt/p1b", agent_id="hermes-x", memory_write_tools=True)
        write_binding(self.dir, on)
        self.assertTrue(read_binding(self.dir).memory_write_tools)
        for bad in ("yes", 1, None):
            d = on.to_json()
            d["memoryWriteTools"] = bad
            with self.assertRaises(BindingInvalid):
                Binding.from_json(d)

    def test_invalid_utf8_is_an_invalid_binding_not_an_exception(self) -> None:
        with open(os.path.join(self.dir, "plur1bus.json"), "wb") as f:
            f.write(b'{"schema": "plur1bus.hermes-binding/1", "home": "\xff\xfe"}')
        with self.assertRaises(BindingInvalid) as cm:
            read_binding(self.dir)
        self.assertIn("UTF-8", cm.exception.reason)
