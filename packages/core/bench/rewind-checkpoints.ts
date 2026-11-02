/** Synthetic native-checkpoint cost probe; no provider, network or B1 acceptance claim. Run with the source condition. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, devNull, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { memoryAuditSink } from "../src/rbac/audit.ts";
import { SessionStore } from "../src/session/store.ts";
import { checkpointEnvironment, RewindCheckpoints } from "../src/session/rewind-checkpoints.ts";

const root = mkdtempSync(join(tmpdir(), "cx-checkpoint-cost-"));
const git = (...args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-C", root, ...args],
  { env: checkpointEnvironment(process.env), encoding: "utf8" });
let store: SessionStore | undefined, checkpoints: RewindCheckpoints | undefined;
try {
  git("init", "-q");
  for (let i = 0; i < 100; i++) writeFileSync(join(root, `tracked-${i}.txt`), "fixture contents\n".repeat(1024));
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  store = new SessionStore({ path: ":memory:" });
  const session = store.createSession({ kind: "card", agentId: "a", owner: "owner" });
  let enabled = false, lookups = 0;
  checkpoints = new RewindCheckpoints({ store, audit: memoryAuditSink(), now: Date.now,
    fileProjects: () => enabled ? ["p"] : [], retentionTurns: () => 50,
    project: () => { lookups++; return { projectId: "p", cardId: "c", root }; },
    approval: { request: async () => ({ approved: false }), begin: () => false } });
  const results = [];
  for (const mode of [false, true]) {
    enabled = mode;
    const samples: number[] = [], before = lookups;
    for (let i = 0; i < 20; i++) {
      const start = store.beginTurn(session.id, "synthetic task", 1), at = performance.now();
      await checkpoints.capture({ sessionId: session.id, turnId: start.turn.id, personId: "owner", signal: new AbortController().signal });
      samples.push(performance.now() - at);
      store.completeTurn(start.turn.id, { text: "done", tokens: 1 });
    }
    const rawSamplesMs = [...samples];
    samples.sort((a, b) => a - b);
    results.push({ enabled: mode, samples: samples.length, rawSamplesMs, warmups: 0, outliersDiscarded: 0,
      p50Ms: samples[9]!, p95Ms: samples[18]!, bindingLookups: lookups - before });
  }
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    git: git("--version").trim(), trackedFiles: 100, trackedBytes: 100 * 1024 * "fixture contents\n".length,
    hardware: { os: release(), cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, memoryBytes: totalmem() },
    methodology: "20 samples per mode, no discarded warmups or outliers, nearest-rank percentiles; OS caches uncontrolled",
    bindingResolver: "constant fixture, not a production board scan", results }, null, 2) + "\n");
  store.archiveSession(session.id); await checkpoints.idle();
} finally {
  await checkpoints?.close(); store?.close(); rmSync(root, { recursive: true, force: true });
}
