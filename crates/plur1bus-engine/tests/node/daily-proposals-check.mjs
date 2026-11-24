// Exercise the pinned resolver against a native receipt in a private synthetic copy.
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
  await writeFile(resolved, input);
  let calls = 0;
  const result = await runConflictResolver({
    workspaceDir: home,
    agentId: receipt.original.agentId,
    llmCfg: {},
    callLlm: async () => {
      calls++;
      return JSON.stringify({ resolution: "uncertain", confidence: 0 });
    },
  });
  assert.equal(result.note, "no_eligible_conflicts");
  assert.equal(calls, 0);
  assert.equal(await readFile(resolved, "utf8"), input);
} finally {
  await rm(home, { recursive: true });
}
