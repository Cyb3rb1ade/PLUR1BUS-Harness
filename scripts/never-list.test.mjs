import assert from "node:assert/strict";
import test from "node:test";
import { foreignClientFindings, FOREIGN_CLIENT_RULES } from "./foreign-client-fingerprints.mjs";
import { openaiWorkflowFindings } from "./openai-workflow-gate.mjs";
const samples = ["app_" + "EMoamEEZ73f0CkXaXp7hrann", "CODEX_" + "APP_SERVER_LOGIN_CLIENT_ID", "codex_cli_" + "simplified_flow", "You are Claude Code, " + "Anthropic's official CLI"];
test("D110 source catalogue detects every rule across product roots, including importer exemptions", () => {
  assert.equal(samples.length, FOREIGN_CLIENT_RULES.length);
  for (const path of ["packages/core/src/import/probe.ts", "crates/a/src/lib.rs", "desktop/main.ts", "apps/desktop/ui/src/probe.ts"]) {
    for (const sample of samples) assert.equal(foreignClientFindings(path, sample).length, 1);
    for (const clean of ["redact-probe-client-id", "dynamic_agent_client", "oaiapp_…"]) assert.deepEqual(foreignClientFindings(path, clean), []);
    assert.ok(foreignClientFindings(path, "oaiapp_" + "redact_probe_registration").length);
  }
});
const secret = "${{ secrets." + "OPENAI_API_KEY }}";
const job = (gate = "    if: github.event_name == 'workflow_dispatch' && vars.PLUR1BUS_OPENAI_LIVE == '1'", environment = "    environment: provider-live") => `on: workflow_dispatch\njobs:\n  openai-live:\n${gate}\n${environment}\n    steps:\n      - run: live\n        env:\n          OPENAI_API_KEY: ${secret}\n`;
test("D110 workflows refuse provider secrets outside the explicit owner gate", () => {
  assert.deepEqual(openaiWorkflowFindings(".github/workflows/nightly.yml", job()), []);
  for (const text of [job(""), job(undefined, ""), job().replace("openai-live:", "offline:"), `env:\n  KEY: ${secret}\n` + job(), job().replace(secret, '${{ secrets["OPENAI_API_KEY"] }}').replace("openai-live:", "offline:"), "jobs:\n  offline:\n    secrets: inherit\n"]) assert.ok(openaiWorkflowFindings(".github/workflows/nightly.yml", text).length);
  assert.ok(openaiWorkflowFindings(".github/workflows/ci.yml", job()).length);
});
