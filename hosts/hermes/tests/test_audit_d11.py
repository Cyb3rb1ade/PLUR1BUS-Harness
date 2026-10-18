"""Audit round D (agent d11): regression tests for the Hermes host adapter.

Each class pins one finding: input the old code mishandled (lone surrogates, deeply nested JSON, a child's
non-object output, a client factory that raises, an unresolvable home, a bare ``bin``)."""

import io
import json
import logging
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest import mock

from tests.fake_client import Sandbox, requires_core

import argparse

from plur1bus import Plur1busMemoryProvider, cli
from plur1bus.binding import BindingInvalid, agent_id_for, default_hermes_root, read_binding, read_registry, resolve_hermes_home
from plur1bus.journal import CaptureJournal
from plur1bus.mapping import EntryInvalid, caller_for, session_key_for, turn_messages, validate_entry

LONE = "ab\ud800cd"  # a lone surrogate: what a lossy decode upstream can hand over


def _tmp(tc: unittest.TestCase) -> str:
    d = tempfile.mkdtemp(prefix="p1d11-")
    tc.addCleanup(shutil.rmtree, d, ignore_errors=True)
    return d


def _encodable(s: str) -> bool:
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


class LoneSurrogateTest(unittest.TestCase):
    """F1: text with a lone surrogate must not raise out of the mapping (it ran inside Hermes' ``sync_turn``)."""

    def test_turn_messages_survive_a_lone_surrogate(self) -> None:
        turn = turn_messages(LONE, "answer " + LONE, None)
        self.assertEqual([m["role"] for m in turn], ["user", "assistant"])
        self.assertTrue(all(_encodable(m["content"]) for m in turn))
        self.assertIn("cd", turn[0]["content"])

    def test_turn_messages_fallback_path_and_list_parts(self) -> None:
        turn = turn_messages("", "", [{"role": "user", "content": [{"text": LONE}]}])
        self.assertEqual(len(turn), 1)
        self.assertTrue(_encodable(turn[0]["content"]))

    def test_claimed_identity_and_session_key(self) -> None:
        caller = caller_for("email", LONE, None)
        self.assertTrue(_encodable(caller.user_id))
        self.assertTrue(_encodable(session_key_for("s", LONE)))
        self.assertTrue(_encodable(session_key_for("s" * 400 + LONE, None)))

    def test_validate_entry_refuses_instead_of_raising_unicode_error(self) -> None:
        entry = {
            "agentId": "hermes-x",
            "caller": {"accountId": "hermes:cli", "userId": "local"},
            "messages": [{"role": "user", "content": LONE}],
        }
        with self.assertRaises(EntryInvalid):
            validate_entry(entry, "hermes-x")

    def test_journal_keeps_an_entry_with_a_lone_surrogate_intact(self) -> None:
        j = CaptureJournal(os.path.join(_tmp(self), "j"))
        j.append({"id": "1", "messages": [{"role": "user", "content": LONE}]})
        got: list[dict] = []
        self.assertEqual(j.drain(got.append), 1)
        self.assertEqual(got[0]["messages"][0]["content"], LONE)
        j.dead_letter({"id": "2", "messages": [{"role": "user", "content": LONE}]}, "E_X")
        self.assertEqual(j.dead_letters()[0]["entry"]["messages"][0]["content"], LONE)

    @unittest.skipIf(os.name == "nt", "undecodable file names are a POSIX matter")
    def test_agent_id_for_a_home_with_undecodable_bytes(self) -> None:
        home = os.path.join(_tmp(self), os.fsdecode(b"h\xff\xfe"))
        agent = agent_id_for(home, default_root=os.path.join(_tmp(self), ".hermes"))
        self.assertRegex(agent, r"^hermes-home-[0-9a-f]{8}$")


class DeepJsonTest(unittest.TestCase):
    """F2: deeply nested JSON raises ``RecursionError``, not ``ValueError``; it must not escape the readers."""

    DEEP = "[" * 200000

    def test_read_binding_and_registry(self) -> None:
        d = _tmp(self)
        with open(os.path.join(d, "plur1bus.json"), "w") as f:
            f.write(self.DEEP)
        with self.assertRaises(BindingInvalid):
            read_binding(d)
        os.makedirs(os.path.join(d, "hosts"))
        with open(os.path.join(d, "hosts", "hermes-bindings.json"), "w") as f:
            f.write(self.DEEP)
        with self.assertRaises(BindingInvalid):
            read_registry(d)

    def test_a_deep_journal_line_is_set_aside_and_the_queue_goes_on(self) -> None:
        j = CaptureJournal(os.path.join(_tmp(self), "j"))
        j.append({"id": "good-1", "messages": []})
        with open(j.path, "ab") as f:
            f.write(b'\n{"a":' * 1 + b'{"a":' * 100000 + b"1" + b"}" * 100001 + b"\n")
        j.append({"id": "good-2", "messages": []})
        got: list[str] = []
        self.assertEqual(j.drain(lambda e: got.append(e["id"])), 2)
        self.assertEqual(got, ["good-1", "good-2"])
        self.assertEqual(j.counts()["rejected"], 1)
        self.assertEqual(j.counts()["queued"], 0)

    def test_a_deep_state_file_reads_as_empty_counters(self) -> None:
        j = CaptureJournal(os.path.join(_tmp(self), "j"))
        j.append({"id": "1", "messages": []})
        with open(j.state_path, "w") as f:
            f.write(DeepJsonTest.DEEP)
        self.assertEqual(j.counts()["queued"], 1)  # counts() never raises
        self.assertIsNone(j.last_error())


class _Proc(SimpleNamespace):
    pass


class BindChildOutputTest(unittest.TestCase):
    """F3: ``bind`` must turn any output of the child into an error document, never a traceback."""

    def _bind(self, runner: object, **kw: object) -> dict:
        d = _tmp(self)
        hermes, p1 = os.path.join(d, "h"), os.path.join(d, "p")
        os.makedirs(hermes)
        os.makedirs(p1)
        exe = os.path.join(d, "plur1bus")
        with open(exe, "w") as f:
            f.write("")
        os.chmod(exe, 0o755)
        return cli.bind(hermes, home=p1, bin=kw.pop("bin", exe), runner=runner)  # type: ignore[arg-type]

    def test_non_object_json_on_the_last_line(self) -> None:
        for out in ("5\n", "[1, 2]\n", '"text"\n', "null\n"):
            with self.subTest(out=out):
                doc = self._bind(lambda *a, **k: _Proc(stdout=out, returncode=0))
                self.assertFalse(doc["ok"])
                self.assertEqual(doc["error"]["code"], "E_AGENT_CREATE")

    def test_undecodable_output_from_the_child(self) -> None:
        def runner(*a: object, **k: object) -> None:
            raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")

        doc = self._bind(runner)
        self.assertFalse(doc["ok"])
        self.assertEqual(doc["error"]["code"], "E_AGENT_CREATE")
        self.assertNotIn("\xff", json.dumps(doc))

    def test_the_childs_message_is_bounded_and_single_line(self) -> None:
        reply = json.dumps({"schema": "error/1", "error": "E_INVALID_PARAMS", "message": "x" * 100000 + "\n\x1b[31mred"})
        doc = self._bind(lambda *a, **k: _Proc(stdout=reply + "\n", returncode=1))
        msg = doc["error"]["message"]
        self.assertLessEqual(len(msg), 500)
        self.assertNotIn("\x1b", msg)
        self.assertNotIn("\n", msg)

    def test_a_bare_bin_name_is_not_run_from_the_current_directory(self) -> None:
        calls: list[list[str]] = []
        d = _tmp(self)
        on_path = os.path.join(d, "bin")
        os.makedirs(on_path)
        exe = os.path.join(on_path, "plur1bus.exe" if sys.platform == "win32" else "plur1bus")
        with open(exe, "w") as f:
            f.write("")
        os.chmod(exe, 0o755)

        def runner(argv: list[str], **k: object) -> _Proc:
            calls.append(argv)
            return _Proc(stdout='{"schema":"agent.create/1"}\n', returncode=0)

        with mock.patch.dict(os.environ, {"PATH": ""}):
            doc = self._bind(runner, bin="plur1bus")
        self.assertEqual(doc["error"]["code"], "E_NO_BINARY")
        self.assertEqual(calls, [])
        with mock.patch.dict(os.environ, {"PATH": on_path}):
            doc = self._bind(runner, bin="plur1bus")
        self.assertTrue(doc["ok"], doc)
        self.assertEqual(calls[0][0], exe)


@requires_core
class ClientFactoryFailureTest(unittest.TestCase):
    """F4: the memory client's constructor raises ``ValueError`` for a binding home that is not absolute on this
    platform (e.g. a ``C:\\`` path under WSL); that must not escape ``initialize`` or the commands."""

    def setUp(self) -> None:
        self.sb = Sandbox(self)
        self.sb.bind()

    @staticmethod
    def _boom(home: str) -> None:
        raise ValueError("home must be an absolute path")

    def test_initialize_goes_inert_with_a_warning(self) -> None:
        p = Plur1busMemoryProvider(hermes_home=self.sb.hermes_home, client_factory=self._boom)
        self.addCleanup(p.shutdown)
        records: list[str] = []

        class H(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record.getMessage())

        h = H()
        logging.getLogger("plur1bus").addHandler(h)
        self.addCleanup(logging.getLogger("plur1bus").removeHandler, h)
        p.initialize("s1", **self.sb.init_kwargs())
        self.assertEqual(p.prefetch("what did we decide about the roadmap"), "")
        p.sync_turn("hello there", "hi")
        self.assertEqual(p.get_tool_schemas(), [])
        self.assertTrue(any("bind" in m or "home" in m for m in records), records)

    def test_status_and_selftest_report_a_code(self) -> None:
        doc = cli.status_doc(self.sb.hermes_home, self._boom)
        self.assertFalse(doc["core"]["reachable"])
        self.assertEqual(doc["core"]["error"], "ValueError")
        doc = cli.selftest_doc(self.sb.hermes_home, self._boom)
        self.assertFalse(doc["ok"])
        self.assertEqual(doc["checks"][1], {"id": "connect", "ok": False, "detail": "ValueError"})


class HomeMissingTest(unittest.TestCase):
    """F5: without any home directory ``~`` stays literal, and the ``~/.hermes`` that followed was a directory
    under the current directory. Nothing may be read or written there; the commands say what to set."""

    def setUp(self) -> None:
        patcher = mock.patch("os.path.expanduser", lambda p: p)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.env = {"PATH": os.environ.get("PATH", "")}

    def test_resolve_refuses(self) -> None:
        with self.assertRaises(OSError):
            default_hermes_root({}, "linux", None)
        with self.assertRaises(OSError):
            resolve_hermes_home(None, env=self.env)
        self.assertEqual(default_hermes_root({"HOME": "/home/x"}, "linux", None), "/home/x/.hermes")
        self.assertEqual(resolve_hermes_home(None, env={"HERMES_HOME": "/srv/h"}), os.path.abspath("/srv/h"))

    @requires_core
    def test_provider_is_unavailable_with_a_reason(self) -> None:
        p = Plur1busMemoryProvider()
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(p.is_available())
            self.assertIn("HERMES_HOME", p.unavailable_reason())

    def test_commands_exit_1_with_one_line_and_no_traceback(self) -> None:
        parser = argparse.ArgumentParser()
        cli.register_cli(parser)
        for argv in (["status"], ["selftest", "--json"], ["bind"]):
            with self.subTest(argv=argv), mock.patch.dict(os.environ, {}, clear=True):
                args = parser.parse_args(argv)
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    rc = args.func(args)
                self.assertEqual(rc, 1)
                self.assertIn("HERMES_HOME", out.getvalue() + err.getvalue())
                self.assertNotIn("Traceback", out.getvalue() + err.getvalue())
                self.assertFalse(os.path.exists("~"), "nothing is created under the current directory")

    def test_bind_without_a_plur1bus_home_says_so(self) -> None:
        d = _tmp(self)
        with mock.patch.dict(os.environ, {"PATH": os.environ.get("PATH", "")}, clear=True):
            doc = cli.bind(d, bin="/bin/true", runner=mock.Mock(side_effect=AssertionError("must not run")))
        self.assertFalse(doc["ok"])
        self.assertIn("--home", doc["error"]["message"])


if __name__ == "__main__":
    unittest.main()
