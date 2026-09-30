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


def _job(text: str, job: str) -> list[str]:
    """The lines of one job (from ``  <job>:`` to the next job header)."""
    lines = text.splitlines()
    start = lines.index(f"  {job}:")
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[i])), len(lines))
    return lines[start:end]


def _steps(job_lines: list[str]) -> tuple[list[str], list[list[str]]]:
    """(the job's lines before its first step, each step's lines); a step starts at ``      - ``."""
    starts = [i for i, ln in enumerate(job_lines) if ln.startswith("      - ")]
    steps = [job_lines[a:b] for a, b in zip(starts, [*starts[1:], len(job_lines)])]
    return job_lines[: starts[0]] if starts else job_lines, steps


def _step_name(step: list[str]) -> str:
    for ln in step:
        m = re.match(r"^      (?:- |  )name: (.*)$", ln)
        if m:
            return m.group(1).strip()
    return ""


class EngineTokenScopeMixin:
    """T6 review 1: the engine read token lives in the build step only and never in the global gitconfig."""

    def assert_token_scoped(self, text: str, job: str, build_step: str) -> None:
        lines = _job(text, job)
        head, steps = _steps(lines)
        code = [ln for ln in lines if not ln.lstrip().startswith("#")]
        self.assertFalse([ln for ln in head if "GH_ENGINE_READ_TOKEN" in ln], f"{job}: no job-level token")
        holders = [_step_name(st) for st in steps if any("GH_ENGINE_READ_TOKEN" in ln and not ln.lstrip().startswith("#") for ln in st)]
        self.assertEqual(holders, [build_step], f"{job}: the token appears only in the build step")
        self.assertFalse([ln for ln in code if re.search(r"git\s+config\s+--global", ln)], f"{job}: no global gitconfig")
        self.assertFalse([ln for ln in code if "insteadOf" in ln and "GIT_CONFIG_KEY_" not in ln], f"{job}: insteadOf only via GIT_CONFIG_*")
        build = next(st for st in steps if _step_name(st) == build_step)
        self.assertTrue(any("export GIT_CONFIG_COUNT=" in ln for ln in build))
        self.assertTrue(any("unset GH_ENGINE_READ_TOKEN" in ln for ln in build))


class HermesHostWorkflowTest(EngineTokenScopeMixin, unittest.TestCase):
    def setUp(self) -> None:
        self.text = _read("hermes-host.yml")
        self.lines = self.text.splitlines()

    def test_every_action_is_pinned_by_commit_sha(self) -> None:
        uses = [ln for ln in self.lines if re.match(r"^\s*(-\s+)?uses:", ln)]
        self.assertTrue(uses)
        self.assertEqual([ln for ln in uses if not SHA_PIN.match(ln)], [])

    def test_engine_token_only_in_the_build_step(self) -> None:
        self.assert_token_scoped(self.text, "real-hermes", "build harness")

    def test_hermes_installer_comes_from_a_pinned_git_fetch(self) -> None:
        code = "\n".join(ln for ln in self.lines if not ln.lstrip().startswith("#"))
        self.assertNotIn("raw.githubusercontent.com", code)
        self.assertIn('fetch -q --depth 1 https://github.com/NousResearch/hermes-agent "$COMMIT"', code)
        self.assertIn('show "$COMMIT:scripts/install.sh"', code)
        self.assertIn('show "$COMMIT:scripts/install.ps1"', code)
        self.assertIn("runner.environment != 'github-hosted'", code)

    def test_triggers_permissions_and_checkout(self) -> None:
        for needle in ('"clients/**"', '"hosts/**"', '"crates/plur1bus/src/install/**"', '"packages/core/**"', '"scripts/build-hermes-provider.mjs"', "cron: '41 3 * * *'", "workflow_dispatch:"):
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
        # The core payload comes from the release assembler (hoisted, link-free, resolvability-checked), never a raw
        # `pnpm deploy` tree whose deps resolve only through links (CI round 1, windows-2025: 'ajv' not found).
        self.assertIn("node scripts/release/assemble-payload.mjs --target", t)
        self.assertIsNone(re.search(r"pnpm[^\n]*\bdeploy\b", t), "no raw pnpm deploy for the core payload")
        self.assertIn('--core-from "$P1B_CORE_PAYLOAD"', t)
        self.assertIsNone(re.search(r"daemon start", t), "no daemon start after setup (F21)")
        # F9: the real provider tarball; R22a: Hermes pinned by a full commit with that commit's own installer.
        self.assertIn("scripts/build-hermes-provider.mjs", t)
        self.assertRegex(t, r"hermes-commit: [0-9a-f]{40}")
        self.assertIn(":scripts/install.sh", t)
        self.assertIn("--commit", t)
        # R24: never `hermes config set` (0.21.4 strips config.yaml); R17a: the directory before activation.
        self.assertIsNone(re.search(r"config set", t), "never hermes config set (HM2-R24)")
        self.assertLess(t.index("extractall"), t.index("drive_turn.py\" activate"))
        self.assertIn("assert_disposable.py", t)
        self.assertLess(t.index("assert_disposable.py"), t.index("install Hermes"))
        self.assertIsNone(re.search(r"(?i)(api[_-]?key|OPENAI|ANTHROPIC)", t), "no model keys anywhere")


class CiPythonHostJobTest(EngineTokenScopeMixin, unittest.TestCase):
    def test_engine_token_only_in_the_build_step(self) -> None:
        self.assert_token_scoped(_read("ci.yml"), "python-host", "build plur1bus and the core")

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
