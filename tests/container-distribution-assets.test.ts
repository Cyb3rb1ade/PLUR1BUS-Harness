import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
test("distribution image pins bases and requires real metadata", () => {
  const dockerfile = read("containers/harness/Dockerfile");
  for (const line of dockerfile.split("\n").filter(l => l.startsWith("FROM "))) assert.match(line, /@sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(dockerfile, /ARG (?:VCS_REF|CREATED|SOURCE_DATE_EPOCH)=/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(read("containers/harness/entrypoint.sh"), /setpriv --no-new-privs/);
  assert.match(dockerfile, /--mount=type=secret,id=engine_token/);
  assert.doesNotMatch(dockerfile, /(?:ARG|ENV)\s+(?:GH_ENGINE_READ_TOKEN|engine_token)/);
});
test("publication actions are pinned and push is isolated from PRs", () => {
  const workflow = read(".github/workflows/containers.yml");
  for (const use of workflow.matchAll(/uses:\s+(\S+)/g)) assert.match(use[1] ?? "", /@[0-9a-f]{40}$/);
  assert.match(workflow, /github.event_name == 'push'/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /continue-on-error: true/);
});
test("compose has no default host API and preserves hardening", () => {
  const compose = read("containers/compose.yaml");
  assert.doesNotMatch(compose, /^\s+ports:/m);
  for (const invariant of ["read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "pids_limit:", "mem_limit:"]) assert.ok(compose.includes(invariant));
  assert.match(read("containers/compose.api.yaml"), /127\.0\.0\.1:/);
});
