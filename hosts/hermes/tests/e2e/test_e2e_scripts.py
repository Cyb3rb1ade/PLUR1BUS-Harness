"""Offline tests of the real-Hermes scripts: the ``memory.provider`` line edit (HM2-R24) and the stub model."""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import tempfile
import unittest
import urllib.request
from unittest import mock
from contextlib import redirect_stderr, redirect_stdout

import drive_turn as dt
import stub_model_server as sms
from tests import FIXTURES_DIR

HERMES_CLI_FIXTURES = os.path.join(FIXTURES_DIR, "hermes-cli")
HERMES_VERSION = re.compile(r"^Hermes Agent v(\d+)\.(\d+)\.(\d+) \((\d{4}\.\d+\.\d+)\)")


def _fixture(name: str) -> str:
    with open(os.path.join(HERMES_CLI_FIXTURES, name), encoding="utf-8") as f:
        return f.read()


class VersionOutputTest(unittest.TestCase):
    def test_documented_release_outputs_match_the_version_pattern(self) -> None:
        expected = {
            "version-min.txt": ("0.21.4", "2026.9.21"),
            "version-latest.txt": ("0.21.5", "2026.9.24"),
        }
        for fixture, (version, date) in expected.items():
            with self.subTest(fixture=fixture):
                output = _fixture(fixture).splitlines()
                self.assertEqual(output[0], "$ hermes --version")
                match = HERMES_VERSION.match(output[1])
                self.assertIsNotNone(match)
                self.assertEqual((".".join(match.groups()[:3]), match.group(4)), (version, date))

    def test_unreleased_git_version_is_unknown_not_a_release_version(self) -> None:
        output = _fixture("version-main.txt").splitlines()
        self.assertEqual(output[0], "$ hermes --version")
        self.assertIsNone(HERMES_VERSION.match(output[1]))
        self.assertEqual(output[-1], "[exit 0]")


class ConfigSetCompatibilityTest(unittest.TestCase):
    def test_provider_line_edit_preserves_comments_and_unrelated_settings(self) -> None:
        before = _fixture("config-set-before.yaml")
        after = _fixture("config-set-after.yaml")
        self.assertEqual(dt.set_memory_provider(before, "plur1bus"), after)


class LineEditTest(unittest.TestCase):
    def test_no_memory_block_appends_one(self) -> None:
        src = "model:\n  provider: custom\n  default: stub-model\n"
        self.assertEqual(dt.set_memory_provider(src, "plur1bus"), src + "memory:\n  provider: plur1bus\n")
        self.assertEqual(dt.set_memory_provider("model: {}", "plur1bus"), "model: {}\nmemory:\n  provider: plur1bus\n")

    def test_existing_provider_is_replaced_and_everything_else_kept(self) -> None:
        src = (
            "# my comment\nmemory:\n    # which provider\n    memory_enabled: true\n    provider: honcho  # was set by hand\n"
            "    nested:\n        provider: keep-me\nterminal:\n  provider: keep-too\n"
        )
        want = src.replace("provider: honcho  # was set by hand", "provider: plur1bus  # was set by hand")
        self.assertEqual(dt.set_memory_provider(src, "plur1bus"), want)

    def test_empty_provider_and_missing_child_and_crlf(self) -> None:
        self.assertEqual(dt.set_memory_provider("memory:\n  provider: ''\n", "plur1bus"), "memory:\n  provider: plur1bus\n")
        self.assertEqual(
            dt.set_memory_provider("memory:\n  memory_enabled: true\nx: 1\n", "plur1bus"),
            "memory:\n  provider: plur1bus\n  memory_enabled: true\nx: 1\n",
        )
        self.assertEqual(dt.set_memory_provider("memory:\r\nx: 1\r\n", "plur1bus"), "memory:\r\n  provider: plur1bus\r\nx: 1\r\n")

    def test_flow_style_memory_and_odd_values_are_refused(self) -> None:
        with self.assertRaises(dt.Failure):
            dt.set_memory_provider("memory: {provider: honcho}\n", "plur1bus")
        with self.assertRaises(dt.Failure):
            dt.set_memory_provider("", "plur1bus: x")

    def test_activate_needs_the_provider_directory_first(self) -> None:
        home = tempfile.mkdtemp(prefix="p1b-hh-")
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        with open(os.path.join(home, "config.yaml"), "w") as f:
            f.write("model:\n  provider: custom\n")
        with redirect_stderr(io.StringIO()):
            self.assertEqual(dt.main(["activate", "--hermes-home", home]), 1, "no plugins/plur1bus yet (HM2-R17a)")
        with open(os.path.join(home, "config.yaml")) as f:
            self.assertNotIn("memory", f.read())
        os.makedirs(os.path.join(home, "plugins", "plur1bus"))
        for name in ("__init__.py", "plugin.yaml"):
            open(os.path.join(home, "plugins", "plur1bus", name), "w").close()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(dt.main(["activate", "--hermes-home", home]), 0)
        with open(os.path.join(home, "config.yaml")) as f:
            self.assertEqual(f.read(), "model:\n  provider: custom\nmemory:\n  provider: plur1bus\n")


class RecalledFenceTest(unittest.TestCase):
    def test_the_fact_counts_only_inside_a_memory_record_fence(self) -> None:
        fenced = '<relevant-memories>\n  <memory-record id="x" epistemic="observed"><quoted-evidence>' + dt.FACT_PROMPT + "</quoted-evidence></memory-record>\n</relevant-memories>\n" + dt.QUESTION
        self.assertTrue(dt.recalled_in({"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": fenced}]}))
        self.assertTrue(dt.recalled_in({"messages": [{"role": "user", "content": [{"type": "text", "text": fenced}]}]}))
        self.assertFalse(dt.recalled_in({"messages": [{"role": "user", "content": dt.FACT_PROMPT + " " + dt.QUESTION}]}), "unfenced")
        self.assertFalse(dt.recalled_in({"messages": [{"role": "user", "content": '<memory-record id="y">other</memory-record> pier four'}]}))


class StubModelTest(unittest.TestCase):
    def setUp(self) -> None:
        d = tempfile.mkdtemp(prefix="p1b-stub-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        self.log = os.path.join(d, "requests.ndjson")
        self.srv = sms.serve(0, self.log)
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}/v1"

    def post(self, body: dict) -> bytes:
        req = urllib.request.Request(self.base + "/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer no-key-required"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read()

    def test_models_streaming_and_plain_completions_and_the_request_log(self) -> None:
        with urllib.request.urlopen(self.base + "/models", timeout=10) as r:
            self.assertEqual(json.loads(r.read())["data"][0]["id"], sms.MODEL)
        stream = self.post({"model": "stub-model", "stream": True, "messages": [{"role": "user", "content": "hello there"}]}).decode()
        events = [ln[len("data: "):] for ln in stream.splitlines() if ln.startswith("data: ")]
        self.assertEqual(events[-1], "[DONE]")
        chunks = [json.loads(e) for e in events[:-1]]
        self.assertEqual(chunks[0]["choices"][0]["delta"]["content"], sms.REPLY)
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "stop")
        plain = json.loads(self.post({"model": "stub-model", "messages": [{"role": "user", "content": "title?"}]}))
        self.assertEqual(plain["choices"][0]["message"]["content"], sms.REPLY)
        logged = dt.stub_requests(self.log)
        self.assertEqual([r["request"].get("stream") for r in logged], [True, None])
        with open(self.log, encoding="utf-8") as f:
            self.assertNotIn("no-key-required", f.read(), "headers are never logged")

    def test_binding_does_no_reverse_lookup(self) -> None:
        # macos-15 (CI round 1): HTTPServer.server_bind's getfqdn(127.0.0.1) outlasted the job's wait for the port.
        def no_dns(*_a: object) -> str:
            raise AssertionError("socket.getfqdn called while binding the stub")

        with mock.patch("socket.getfqdn", no_dns):
            srv = sms.serve(0, None)
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        self.assertEqual(srv.server_name, "127.0.0.1")
        with urllib.request.urlopen(f"http://127.0.0.1:{srv.server_address[1]}/v1/models", timeout=10) as r:
            self.assertEqual(json.loads(r.read())["data"][0]["id"], sms.MODEL)


if __name__ == "__main__":
    unittest.main()
