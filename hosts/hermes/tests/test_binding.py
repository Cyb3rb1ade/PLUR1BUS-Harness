import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

from tests import FIXTURES_DIR

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
        self.assertEqual(len(read_registry(p1home)), len(homes), "the file lock serialises read-modify-write")

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
