// Actual frozen A1 maintenance-gate transitions; no store, host, provider or network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pin = "9b935ce1f970bd92a931aa99a58c620669c8085f";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const gitRoot = process.env.PLUR1BUS_ENGINE_GIT;
assert(source && gitRoot && process.version === "v24.21.0");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const path = "lib/memory-maintenance-gate.js";
const bytes = readFileSync(join(source, path));
assert.equal(sha(bytes), sha(execFileSync("git", ["-C", gitRoot, "show", `${pin}:${path}`])));
const { createMemoryMaintenanceGate } = await import(pathToFileURL(join(source, path)).href);
const now = 1800000000000;
const input = { reason: "reembedding", migrationId: "migration-1" };
const status = { op: "status" };
const enter = { op: "enter", input };
const exit = { op: "exit", input };
const scenarios = [
  { name: "inactive", actions: [status] },
  { name: "enter-exit", actions: [enter, status, exit, status] },
  { name: "already-active", actions: [enter, enter, status] },
  { name: "not-active", actions: [exit, status] },
  { name: "wrong-reason", actions: [enter, { op: "exit", input: { ...input, reason: "other" } }, status, exit] },
  { name: "wrong-id", actions: [enter, { op: "exit", input: { ...input, migrationId: "other" } }, status, exit] },
  ...["", "UPPER", "_bad", "bad-name", "a".repeat(65)].map(reason => ({
    name: `reason-${reason || "empty"}`, actions: [{ op: "enter", input: { ...input, reason } }, status],
  })),
  ...["", "_bad", "has/slash", "a".repeat(65)].map(migrationId => ({
    name: `id-${migrationId || "empty"}`, actions: [{ op: "enter", input: { ...input, migrationId } }, status],
  })),
  { name: "max-identifiers", actions: [
    { op: "enter", input: { reason: "a".repeat(64), migrationId: "1" + "._-".repeat(21) } }, status,
  ] },
  { name: "external-inactive", external: { active: false }, actions: [status] },
  { name: "external-active", external: { active: true, reason: "durable", since: 123 }, actions: [status] },
  { name: "external-fraction", external: { active: true, reason: "durable", since: -123.25 }, actions: [status] },
  { name: "external-zero", external: { active: true, reason: "durable", since: -0 }, actions: [status] },
  { name: "external-large", external: { active: true, reason: "durable", since: 72000000000000000 },
    actions: [status] },
  { name: "external-invalid-reason", external: { active: true, reason: "Bad", since: 123 }, actions: [status] },
  { name: "external-missing-time", external: { active: true, reason: "durable" }, actions: [status] },
  { name: "external-string-time", external: { active: true, reason: "durable", since: "123" }, actions: [status] },
  { name: "external-not-true", external: { active: "true" }, actions: [status] },
  { name: "external-error", externalError: true, actions: [status] },
  { name: "local-precedence", externalError: true, actions: [enter, status, exit, status] },
  { name: "durable-after-exit", external: { active: true, reason: "durable", since: 123 },
    actions: [enter, status, exit, status] },
];
async function capture() {
  const cases = [];
  for (const scenario of scenarios) {
    const externalStatus = "external" in scenario || scenario.externalError ? () => {
      if (scenario.externalError) throw new Error("external unavailable");
      return scenario.external;
    } : null;
    const gate = createMemoryMaintenanceGate({ now: () => now, externalStatus });
    const outputs = [];
    for (const action of scenario.actions) {
      try {
        outputs.push({ value: await gate[action.op](action.input) });
      } catch (error) {
        outputs.push({ error: error.message });
      }
    }
    cases.push({ ...scenario, outputs });
  }
  return cases;
}
globalThis.fetch = async () => { throw new Error("network forbidden"); };
const cases = await capture();
assert.deepEqual(await capture(), cases);
const output = JSON.stringify({ pin, node: process.version, now, sourceHashes: [{ path, sha256: sha(bytes) }],
  boundaries: { implementation: "actual A1 maintenance gate", clock: "fixed", normalization: "none" }, cases }, null, 2);
writeFileSync(new URL("golden/maintenance-gate.json", import.meta.url), output + "\n");
console.log(`Recorded ${cases.length} A1 gate scenarios twice; SHA-256 ${sha(output + "\n")}`);
