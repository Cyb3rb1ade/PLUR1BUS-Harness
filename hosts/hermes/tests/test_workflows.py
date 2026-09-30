"""Line scans of the HM2 Task 6 workflows (ruling F8: no YAML parser; stdlib only). actionlint checks the syntax."""

from __future__ import annotations

import os
import re
import unittest

from tests import REPO_ROOT

WORKFLOWS = os.path.join(REPO_ROOT, ".github", "workflows")
SHA_PIN = re.compile(r"^\s*(?:-\s+)?uses:\s+[\w.-]+/[\w./-]+@[0-9a-f]{40}(\s+#.*)?$")


def _read(name: str) -> str:
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as f:
        return f.read()


class HermesHostWorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.text = _read("hermes-host.yml")
        self.lines = self.text.splitlines()

    def test_every_action_is_pinned_by_commit_sha(self) -> None:
        uses = [ln for ln in self.lines if re.match(r"^\s*(-\s+)?uses:", ln)]
        self.assertTrue(uses)
        self.assertEqual([ln for ln in uses if not SHA_PIN.match(ln)], [])

    def test_triggers_permissions_and_checkout(self) -> None:
        for needle in ('"clients/**"', '"hosts/**"', '"crates/plur1bus/src/install/**"', "cron: '41 3 * * *'", "workflow_dispatch:"):
            self.assertIn(needle, self.text)
        self.assertRegex(self.text, r"(?m)^permissions:\n  contents: read$")
        checkouts = [i for i, ln in enumerate(self.lines) if "actions/checkout@" in ln]
        self.assertTrue(checkouts)
        for i in checkouts:
            self.assertIn("persist-credentials: false", "\n".join(self.lines[i : i + 3]))

    def test_real_hermes_job_follows_the_rulings(self) -> None:
        t = "\n".join(ln for ln in self.lines if not ln.lstrip().startswith("#"))  # comments may name what is banned
        self.assertIn("  real-hermes:", t)
        for os_ in ("ubuntu-24.04", "macos-15", "windows-2025"):
            self.assertIn(os_, t)
        self.assertIn("continue-on-error: ${{ matrix.os == 'windows-2025' }}", t)
        # F21: the flat-embedder seam for setup and everything after it; setup starts the supervisor itself.
        self.assertIn('PLUR1BUS_ALLOW_TEST_INTERNALS: "1"', t)
        self.assertIn("PLUR1BUS_TEST_INTERNALS: flat-embedder", t)
        self.assertRegex(t, r"setup --profile host --non-interactive --no-service --core-from")
        self.assertIsNone(re.search(r"daemon start", t), "no daemon start after setup (F21)")
        # F9: the real provider tarball; R22a: Hermes pinned by a full commit with that commit's own installer.
        self.assertIn("scripts/build-hermes-provider.mjs", t)
        self.assertRegex(t, r"hermes-commit: [0-9a-f]{40}")
        self.assertIn("/scripts/install.sh", t)
        self.assertIn("--commit", t)
        # R24: never `hermes config set` (0.21.4 strips config.yaml); R17a: the directory before activation.
        self.assertIsNone(re.search(r"config set", t), "never hermes config set (HM2-R24)")
        self.assertLess(t.index("extractall"), t.index("drive_turn.py\" activate"))
        self.assertIn("assert_disposable.py", t)
        self.assertLess(t.index("assert_disposable.py"), t.index("install Hermes"))
        self.assertIsNone(re.search(r"(?i)(api[_-]?key|OPENAI|ANTHROPIC)", t), "no model keys anywhere")


class CiPythonHostJobTest(unittest.TestCase):
    def test_python_host_job(self) -> None:
        t = _read("ci.yml")
        self.assertIn("  python-host:", t)
        job = t[t.index("  python-host:") :]
        for needle in (
            '{ os: ubuntu-24.04, python: "3.11" }', '{ os: ubuntu-24.04, python: "3.13" }', "macos-15", "windows-2025",
            "windows-11-arm", "--require-hashes", "NamedPipeTest", "r.testsRun == 6", 'PLUR1BUS_LIVE_REQUIRED: "1"',
            "hosts/hermes/tests/e2e", "clients/python/plur1bus-memory-client/tests/live",
        ):
            self.assertIn(needle, job)


if __name__ == "__main__":
    unittest.main()
