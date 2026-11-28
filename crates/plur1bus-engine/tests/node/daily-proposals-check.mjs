// Exercise the pinned resolver in both directions in a private synthetic copy.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(join(process.cwd(), "package.json"));
const engine = dirname(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const { runConflictResolver } = await import(pathToFileURL(join(engine, "lib/jobs/conflict-resolver.js")));
const input = await readFile(process.argv[2], "utf8");
const receipt = JSON.parse(input);
const home = await mkdtemp(join(tmpdir(), "native-daily-receipts-"));
try {
  const sidecars = join(home, ".adaptive-learning");
  await mkdir(sidecars);
  const resolved = join(sidecars, "conflict-resolved.jsonl");
  await writeFile(join(sidecars, "conflict-log.jsonl"), JSON.stringify(receipt.original) + "\n");
  let calls = 0;
  const resolve = () => runConflictResolver({
    workspaceDir: home,
    agentId: receipt.original.agentId,
    llmCfg: {},
    callLlm: async () => {
      calls++;
      return JSON.stringify({
        resolution: receipt.resolution,
        confidence: receipt.confidence,
        reason: receipt.reason,
      });
    },
  });

  await resolve();
  assert.equal(calls, 1);
  const nodeBytes = await readFile(resolved, "utf8");
  const nodeReceipt = JSON.parse(nodeBytes);
  for (const field of ["original", "resolution", "confidence", "reason", "recommendation", "dryRun"]) {
    assert.deepEqual(nodeReceipt[field], receipt[field], field);
  }
  assert.ok(Number.isFinite(Date.parse(nodeReceipt.resolvedAt)));

  await writeFile(resolved, input);
  const result = await resolve();
  assert.equal(result.note, "no_eligible_conflicts");
  assert.equal(calls, 1);
  assert.equal(await readFile(resolved, "utf8"), input);
  process.stdout.write(nodeBytes);
} finally {
  await rm(home, { recursive: true });
}
