import argparse
import io
import json
import os
import re
import stat
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

from tests import FIXTURES_DIR, PROVIDER_DIR, REPO_ROOT
from tests.fake_client import FakeError, Sandbox, capabilities, requires_core
from plur1bus_memory_client import RPC_VERSION

from plur1bus import cli
from plur1bus.binding import BINDING_SCHEMA, REGISTRY_SCHEMA, Binding, read_binding, read_registry, write_binding
from plur1bus.journal import CaptureJournal

PROVIDER_JSON = os.path.join(FIXTURES_DIR, "provider-json")
WRITE_METHODS = {"memory.capture", "memory.forget", "memory.correct", "memory.share", "memory.checkpoint", "agent.close", "config.set"}

# -- the JSON shapes of ruling F12 (Task 8's shims replay the fixtures below) ----------------------

_OPT_STR = (str, type(None))


def check_status(tc: unittest.TestCase, doc: dict) -> None:
    tc.assertEqual(set(doc), {"schema", "hermesHome", "binding", "bindingError", "core", "journal", "lastError"})
    tc.assertEqual(doc["schema"], "plur1bus.hermes-status/1")
    tc.assertIsInstance(doc["hermesHome"], str)
    if doc["binding"] is not None:
        tc.assertEqual(set(doc["binding"]), {"home", "agentId", "bin", "capture", "recallHardMs", "version", "installedBy"})
        tc.assertIsInstance(doc["binding"]["agentId"], str)
    tc.assertIsInstance(doc["bindingError"], _OPT_STR)
    tc.assertEqual(set(doc["core"]), {"reachable", "rpc", "contract", "instanceId", "error"})
    tc.assertIsInstance(doc["core"]["reachable"], bool)
    tc.assertEqual(set(doc["journal"]), {"path", "queued", "dropped", "rejected", "lost"})
    for k in ("queued", "dropped", "rejected", "lost"):
        tc.assertIsInstance(doc["journal"][k], int)
    tc.assertIsInstance(doc["lastError"], _OPT_STR)


def check_selftest(tc: unittest.TestCase, doc: dict) -> None:
    tc.assertEqual(set(doc), {"schema", "ok", "checks"})
    tc.assertEqual(doc["schema"], "plur1bus.hermes-selftest/1")
    tc.assertIsInstance(doc["ok"], bool)
    tc.assertEqual([c["id"] for c in doc["checks"]], ["binding", "connect", "core.status", "agent.status", "memory.recall"])
    for c in doc["checks"]:
        tc.assertLessEqual(set(c), {"id", "ok", "detail"})
        tc.assertIsInstance(c["ok"], bool)
        tc.assertIsInstance(c.get("detail", ""), str)
    tc.assertEqual(doc["ok"], all(c["ok"] for c in doc["checks"]))


def check_bind(tc: unittest.TestCase, doc: dict) -> None:
    tc.assertLessEqual({"schema", "ok", "hermesHome", "home", "agentId", "created"}, set(doc))
    tc.assertLessEqual(set(doc), {"schema", "ok", "hermesHome", "home", "agentId", "created", "error"})
    tc.assertEqual(doc["schema"], "plur1bus.hermes-bind/1")
    tc.assertEqual("error" in doc, not doc["ok"])


def _load(name: str) -> dict:
    with open(os.path.join(PROVIDER_JSON, name), encoding="utf-8") as f:
        return json.load(f)


def _run(argv: list[str], **kw: object) -> tuple[int, str]:
    parser = argparse.ArgumentParser(prog="hermes plur1bus")
    cli.register_cli(parser)
    args = parser.parse_args(argv)
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = args.func(args, **kw)
    return rc, buf.getvalue()


class FixtureShapeTest(unittest.TestCase):
    def test_fixtures_match_the_shapes(self) -> None:
        check_status(self, _load("status.json"))
        check_status(self, _load("status-no-binding.json"))
        ok, fail = _load("selftest-ok.json"), _load("selftest-fail.json")
        check_selftest(self, ok)
        check_selftest(self, fail)
        self.assertTrue(ok["ok"])
        self.assertFalse(fail["ok"])
        check_bind(self, _load("bind-ok.json"))
        check_bind(self, _load("bind-conflict.json"))
        b = Binding.from_json(_load("binding.json"))
        self.assertEqual(b.schema, BINDING_SCHEMA)
        reg = _load("bindings.json")
        self.assertEqual(reg["schema"], REGISTRY_SCHEMA)
        self.assertTrue(all(isinstance(k, str) and isinstance(v, str) for k, v in reg["bindings"].items()))


@requires_core
class CliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sb = Sandbox(self)

    def test_status_json_reports_binding_core_and_journal(self) -> None:
        self.sb.bind("hermes-work", version="0.1.0", installed_by="installer")
        self.sb.start_core()
        j = CaptureJournal.for_home(self.sb.hermes_home)
        j.append({"agentId": "hermes-work", "messages": [{"role": "user", "content": "queued turn"}]})
        j.reject()
        j.note_error("E_CORE_UNAVAILABLE")
        rc, out = _run(["status", "--json", "--hermes-home", self.sb.hermes_home])
        self.assertEqual(rc, 0)
        doc = json.loads(out)
        check_status(self, doc)
        self.assertEqual(doc["binding"]["agentId"], "hermes-work")
        self.assertEqual(doc["binding"]["home"], self.sb.p1home)
        self.assertEqual(doc["core"], {"reachable": True, "rpc": RPC_VERSION, "contract": "1.4.1", "instanceId": "inst-fixture", "error": None})
        self.assertEqual(doc["journal"], {"path": j.path, "queued": 1, "dropped": 0, "rejected": 1, "lost": 0})
        self.assertEqual(doc["lastError"], "E_CORE_UNAVAILABLE")
        self.assertNotIn("queued turn", out)
        self.assertNotIn(self.sb.core.token, out)
        rc, text = _run(["status", "--hermes-home", self.sb.hermes_home])
        self.assertIn("1 queued", text)
        self.assertIn("1 rejected, 0 lost", text)
        self.sb.stop_core()
        doc = json.loads(_run(["status", "--json", "--hermes-home", self.sb.hermes_home])[1])
        self.assertFalse(doc["core"]["reachable"])
        self.assertEqual(doc["core"]["error"], "E_CORE_UNAVAILABLE")

    def test_status_without_a_binding(self) -> None:
        rc, out = _run(["status", "--json", "--hermes-home", self.sb.hermes_home])
        doc = json.loads(out)
        check_status(self, doc)
        self.assertIsNone(doc["binding"])
        self.assertEqual(doc["bindingError"], "missing")
        self.assertEqual(doc["core"]["error"], "E_NO_BINDING")

    def test_selftest_is_read_only(self) -> None:
        self.sb.bind()
        core = self.sb.start_core(capabilities=capabilities(all_optional=True))
        rc, out = _run(["selftest", "--json", "--hermes-home", self.sb.hermes_home])
        doc = json.loads(out)
        check_selftest(self, doc)
        self.assertEqual(rc, 0, doc)
        self.assertTrue(doc["ok"])
        methods = core.methods()
        self.assertEqual(set(methods) & WRITE_METHODS, set())
        self.assertIn("agent.status", methods)
        recall = [p for m, p in core.calls if m == "memory.recall"]
        self.assertEqual(len(recall), 1)
        self.assertEqual(recall[0]["query"], "plur1bus selftest")
        self.assertNotIn(core.token, out)
        self.assertNotIn("roadmap", out, "recalled text never reaches the output")

    def test_selftest_skips_agent_status_when_not_advertised_and_fails_on_errors(self) -> None:
        self.sb.bind()
        core = self.sb.start_core()
        doc = json.loads(_run(["selftest", "--json", "--hermes-home", self.sb.hermes_home])[1])
        self.assertTrue(doc["ok"])
        self.assertEqual(doc["checks"][3], {"id": "agent.status", "ok": True, "detail": "skipped: not advertised"})
        core.handlers["memory.recall"] = FakeError("E_AGENT_UNKNOWN", "unknown")
        rc, out = _run(["selftest", "--json", "--hermes-home", self.sb.hermes_home])
        doc = json.loads(out)
        self.assertEqual(rc, 1)
        self.assertFalse(doc["ok"])
        self.assertIn("hermes plur1bus bind", doc["checks"][4]["detail"])
        self.sb.stop_core()
        rc, out = _run(["selftest", "--json", "--hermes-home", self.sb.hermes_home])
        doc = json.loads(out)
        check_selftest(self, doc)
        self.assertEqual(rc, 1)
        self.assertEqual(doc["checks"][1], {"id": "connect", "ok": False, "detail": "E_CORE_UNAVAILABLE"})
        rc, text = _run(["selftest", "--hermes-home", self.sb.hermes_home])
        self.assertIn("selftest failed", text)

    def test_selftest_without_a_binding_fails(self) -> None:
        rc, out = _run(["selftest", "--json", "--hermes-home", self.sb.hermes_home])
        doc = json.loads(out)
        check_selftest(self, doc)
        self.assertEqual(rc, 1)
        self.assertFalse(doc["checks"][0]["ok"])

    # -- bind -------------------------------------------------------------------------------------

    def _shim(self, reply: str) -> tuple[str, str]:
        d = os.path.join(self.sb.root, "shim")
        os.makedirs(d, exist_ok=True)
        log = os.path.join(d, "argv.log")
        script = os.path.join(d, "plur1bus.py")
        with open(script, "w", encoding="utf-8") as f:
            f.write(
                f"#!{sys.executable}\n"
                "import json, sys\n"
                f"open({log!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
                f"print({reply!r})\n"
                f"sys.exit(0 if 'agent.create/1' in {reply!r} else 1)\n"
            )
        if sys.platform == "win32":
            path = os.path.join(d, "plur1bus.bat")
            with open(path, "w", encoding="ascii") as f:
                f.write(f'@echo off\r\n"{sys.executable}" "{script}" %*\r\n')
            return path, log
        os.chmod(script, os.stat(script).st_mode | stat.S_IXUSR)
        return script, log

    def _root_env(self) -> dict:
        """Environment that makes <sandbox>/u the user home, so its Hermes default root is the one below."""
        u = os.path.join(self.sb.root, "u")
        return {"LOCALAPPDATA": u} if sys.platform == "win32" else {"HOME": u}

    def _hermes_profile(self, name: str) -> tuple[str, str]:
        root = os.path.join(self.sb.root, "u", "hermes" if sys.platform == "win32" else ".hermes")
        home = os.path.join(root, "profiles", name)
        os.makedirs(home, exist_ok=True)
        return root, home

    def test_bind_runs_plur1bus_agent_create_with_the_folded_id(self) -> None:
        root, home = self._hermes_profile("Work.v2")
        exe, log = self._shim('{"schema":"agent.create/1","agentId":"hermes-work-v2","created":true,"opened":false}')
        with mock.patch.dict(os.environ, self._root_env()):
            rc, out = _run(["bind", "--json", "--hermes-home", home, "--home", self.sb.p1home, "--bin", exe])
        doc = json.loads(out)
        check_bind(self, doc)
        self.assertEqual(rc, 0, doc)
        self.assertEqual(doc["agentId"], "hermes-work-v2")
        self.assertTrue(doc["created"])
        with open(log, encoding="utf-8") as f:
            argv = [json.loads(line) for line in f]
        self.assertEqual(argv, [["--home", self.sb.p1home, "--json", "agent", "create", "hermes-work-v2"]])
        b = read_binding(home)
        self.assertEqual((b.home, b.agent_id, b.bin, b.installed_by), (self.sb.p1home, "hermes-work-v2", exe, "hermes-plur1bus-bind"))
        self.assertEqual(read_registry(self.sb.p1home), {"hermes-work-v2": os.path.realpath(home)})

    def test_bind_accepts_an_existing_agent_and_keeps_binding_fields(self) -> None:
        root, home = self._hermes_profile("work")
        write_binding(home, Binding(home=self.sb.p1home, agent_id="hermes-work", recall_hard_ms=900, capture=False, version="0.1.0", installed_by="installer"))
        # Keyed on the reason; the message match is the fallback for older binaries (second shim).
        for answer in (
            '{"schema":"error/1","error":"E_INVALID_PARAMS","message":"exists","reason":"agent-exists"}',
            '{"schema":"error/1","error":"E_INVALID_PARAMS","message":"agent hermes-work already exists"}',
        ):
            exe, _ = self._shim(answer)
            with mock.patch.dict(os.environ, self._root_env()):
                rc, out = _run(["bind", "--json", "--hermes-home", home, "--bin", exe])
            doc = json.loads(out)
            self.assertEqual(rc, 0, doc)
            self.assertFalse(doc["created"])
        b = read_binding(home)
        self.assertEqual((b.recall_hard_ms, b.capture, b.version, b.installed_by), (900, False, "0.1.0", "installer"))

    def test_bind_refuses_a_case_collision_before_creating_anything(self) -> None:
        root, upper = self._hermes_profile("Work")
        _, lower = self._hermes_profile("work")
        if os.path.samefile(upper, lower):
            self.skipTest("case-insensitive file system")
        exe, log = self._shim('{"schema":"agent.create/1","agentId":"hermes-work","created":true,"opened":false}')
        with mock.patch.dict(os.environ, self._root_env()):
            self.assertEqual(_run(["bind", "--json", "--hermes-home", upper, "--home", self.sb.p1home, "--bin", exe])[0], 0)
            rc, out = _run(["bind", "--json", "--hermes-home", lower, "--home", self.sb.p1home, "--bin", exe])
        doc = json.loads(out)
        check_bind(self, doc)
        self.assertEqual(rc, 1)
        self.assertEqual(doc["error"]["code"], "E_BINDING_CONFLICT")
        self.assertIn(os.path.realpath(upper), doc["error"]["message"])
        self.assertIn(os.path.realpath(lower), doc["error"]["message"])
        with open(log, encoding="utf-8") as f:
            self.assertEqual(len(f.readlines()), 1, "agent create ran only for the first home")
        self.assertIsNone(read_binding(lower))

    def test_bind_reports_a_failing_agent_create(self) -> None:
        _, home = self._hermes_profile("x")
        exe, _ = self._shim('{"schema":"error/1","error":"E_CONFIG_CONFLICT","message":"config changed meanwhile"}')
        rc, out = _run(["bind", "--json", "--hermes-home", home, "--home", self.sb.p1home, "--bin", exe])
        doc = json.loads(out)
        self.assertEqual(rc, 1)
        self.assertEqual(doc["error"]["code"], "E_CONFIG_CONFLICT")
        self.assertIsNone(read_binding(home))
        rc, out = _run(["bind", "--json", "--hermes-home", home, "--home", self.sb.p1home, "--bin", os.path.join(self.sb.root, "missing")])
        self.assertEqual(json.loads(out)["error"]["code"], "E_AGENT_CREATE")

    def test_bind_turns_a_write_failure_into_an_error_document(self) -> None:
        _, home = self._hermes_profile("w")
        exe, _ = self._shim('{"schema":"agent.create/1","agentId":"x","created":true,"opened":false}')
        with mock.patch.object(cli, "write_binding", side_effect=PermissionError(13, "denied")):
            rc, out = _run(["bind", "--json", "--hermes-home", home, "--home", self.sb.p1home, "--bin", exe])
        doc = json.loads(out)
        check_bind(self, doc)
        self.assertEqual(rc, 1)
        self.assertEqual(doc["error"]["code"], "E_BINDING_WRITE")
        with mock.patch.object(cli, "register_binding", side_effect=OSError("registry locked")):
            doc = json.loads(_run(["bind", "--json", "--hermes-home", home, "--home", self.sb.p1home, "--bin", exe])[1])
        self.assertEqual(doc["error"]["code"], "E_BINDING_WRITE")

    # -- plugin.yaml ------------------------------------------------------------------------------

    def test_plugin_yaml_declares_no_python_dependencies(self) -> None:
        with open(os.path.join(PROVIDER_DIR, "plugin.yaml"), encoding="utf-8") as f:
            text = f.read()
        keys = re.findall(r"^([A-Za-z_]+):", text, re.M)
        self.assertEqual(keys, ["name", "version", "description", "hooks"])
        self.assertIn("name: plur1bus\n", text)
        self.assertNotRegex(text, r"(pip|python)_dependencies")
        self.assertFalse(os.path.exists(os.path.join(PROVIDER_DIR, "pyproject.toml")))
        self.assertFalse(os.path.exists(os.path.join(PROVIDER_DIR, "requirements.txt")))
        hooks = re.findall(r"^  - (\S+)$", text, re.M)
        self.assertEqual(hooks, ["on_session_end", "on_pre_compress"])
        with open(os.path.join(REPO_ROOT, "Cargo.toml"), encoding="utf-8") as f:
            harness_version = re.search(r'^version = "([^"]+)"', f.read(), re.M).group(1)
        self.assertIn(f"version: {harness_version}\n", text, "provider carries the harness version (HM2-R22)")
        self.assertTrue(text.isascii())

    def test_register_cli_builds_the_three_commands(self) -> None:
        parser = argparse.ArgumentParser(prog="hermes plur1bus")
        cli.register_cli(parser)
        for action in ("status", "selftest", "bind"):
            args = parser.parse_args([action, "--json"])
            self.assertIs(args.func, cli.plur1bus_command)
            self.assertEqual(args.plur1bus_action, action)
        args = parser.parse_args([])
        self.assertIs(args.func, cli.plur1bus_command)


if __name__ == "__main__":
    unittest.main()


class WhichNoCwdTest(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.mkdtemp(prefix="p1h-which-")
        self.addCleanup(__import__("shutil").rmtree, self.tmp, ignore_errors=True)
        self.cwd = os.path.join(self.tmp, "cwd")
        self.bindir = os.path.join(self.tmp, "bin")
        os.makedirs(self.cwd)
        os.makedirs(self.bindir)
        old = os.getcwd()
        os.chdir(self.cwd)
        self.addCleanup(os.chdir, old)

    def _exe(self, directory: str, name: str) -> str:
        if os.name == "nt" and not name.endswith(".exe"):
            name += ".exe"  # Windows runs a file by its PATHEXT extension only
        path = os.path.join(directory, name)
        with open(path, "w") as f:
            f.write("#!/bin/sh\n")
        os.chmod(path, 0o755)
        return path

    def test_a_binary_in_the_current_directory_is_never_found(self) -> None:
        self._exe(self.cwd, "plur1bus")
        for path in ("", ".", os.pathsep + self.bindir, "." + os.pathsep + "relative/dir", f"bin{os.pathsep}"):
            self.assertIsNone(cli.which_no_cwd("plur1bus", path=path), path)

    def test_an_absolute_path_entry_is_searched(self) -> None:
        found = self._exe(self.bindir, "plur1bus")
        self._exe(self.cwd, "plur1bus")
        self.assertEqual(os.path.normcase(cli.which_no_cwd("plur1bus", path=f".{os.pathsep}{self.bindir}") or ""), os.path.normcase(found))
        self.assertIsNone(cli.which_no_cwd("plur1bus", path=self.cwd + "-nope"))

    def test_a_name_with_a_directory_part_is_refused(self) -> None:
        self._exe(self.bindir, "plur1bus")
        self.assertIsNone(cli.which_no_cwd(os.path.join(self.bindir, "plur1bus"), path=self.bindir))

    def test_windows_tries_pathext_without_the_cwd(self) -> None:
        found = self._exe(self.bindir, "plur1bus.exe")
        self._exe(self.cwd, "plur1bus.exe")
        self.assertEqual(os.path.normcase(cli.which_no_cwd("plur1bus", path=f".{os.pathsep}{self.bindir}", platform="win32", pathext=".com;.exe") or ""), os.path.normcase(found))
        self.assertIsNone(cli.which_no_cwd("plur1bus", path=".", platform="win32", pathext=".com;.exe"))

    @requires_core
    def test_bind_does_not_pick_up_a_binary_from_the_current_directory(self) -> None:
        self._exe(self.cwd, "plur1bus")
        sb = Sandbox(self)
        with mock.patch.dict(os.environ, {"PATH": "." + os.pathsep}):
            doc = cli.bind(sb.hermes_home, home=sb.p1home)
        self.assertFalse(doc["ok"])
        self.assertEqual(doc["error"]["code"], "E_NO_BINARY")
