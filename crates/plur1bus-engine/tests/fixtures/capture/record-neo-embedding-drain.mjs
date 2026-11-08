// RE-05/T5 neo-embedding-drain recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file>
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "b097045b6f115275baa8b15016321c3ba080c812";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") {
  throw new Error("pinned source, read-only git and Node 24.21.0 required");
}
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned neo-embedding-drain source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const { createNeoStore, captureNeoFromAgentEnd } = await import(pathToFileURL(path.join(root, "lib/neo-arch.js")));
const assert = (await import("node:assert/strict")).default;
const { tmpdir } = await import("node:os");
const now = "2026-11-08T12:00:00.000Z";
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return OriginalDate.parse(now); }
};
const workspace = "workspace-dir:v1:/fixture/workspace";
const messages = [
  { role: "user", content: "Architecture decision chosen" },
  { role: "assistant", content: "I will plan the implementation" },
  { role: "user", content: "yes exactly" },
  { role: "assistant", content: "maybe we could use a queue" },
  { role: "user", content: "never leak workspace data" },
];

const keys = ["turns", "candidates", "behavior", "embeddings", "candidateIndex"];
const readRows = (file) => existsSync(file)
  ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const source = (id, content, extra = {}) => ({
  id, content, statement: content, role: "user", agentId: "alpha", workspaceKey: workspace,
  ownerUserId: `user:v2:${"1".repeat(64)}`, scope: "agent_private",
  visibility: { scope: "agent_private", ownerUserId: `user:v2:${"1".repeat(64)}`,
    agentId: "alpha", workspaceIdentity: workspace },
  createdAt: now, embeddingStatus: "pending", ...extra,
});
const specifications = [
  { name: "five-turns-all", capture: true, rounds: [{ impact: "all" }] },
  { name: "five-turns-default-impact", capture: true, rounds: [{}] },
  { name: "five-turns-two-at-a-time", capture: true, rounds: [{ maxItems: 2, impact: "all" }] },
  { name: "five-turns-two-batches", capture: true,
    rounds: [{ maxItems: 5, impact: "all" }, { impact: "all" }] },
  ...["normal", "none", "throw", "empty", "nan", "wrong-dimensions", "scalar"].map(provider => ({
    name: `provider-${provider}`, provider, rounds: [{ impact: "all" }],
  })),
  { name: "failed-attempt-budget", provider: "throw", rounds: [{ maxItems: 1, impact: "all" }] },
  { name: "deferred-then-retry", rounds: [{ provider: "none", impact: "all" }, { impact: "all" }] },
  ...["pending", "deferred", "done", "fresh", "skipped", "missing"].map(status => ({
    name: `queue-status-${status}`, status, rounds: [{ impact: "all" }],
  })),
  ...["low", "medium", "high", "critical", "all"].map(impact => ({
    name: `impact-${impact}`, mixedImpact: true, rounds: [{ impact }],
  })),
  { name: "missing-target", missingTarget: true, rounds: [{ impact: "all" }] },
  { name: "unsupported-target", targetType: "episode", rounds: [{ impact: "all" }] },
  { name: "latest-physical-revision", revised: true, rounds: [{ impact: "all" }] },
  { name: "duplicate-queue-latest-last", duplicateQueue: true, rounds: [{ maxItems: 1, impact: "all" }] },
  { name: "foreign-target-is-not-authorized-by-node-drain", foreign: true, rounds: [{ impact: "all" }] },
  { name: "cancel-after-first-result", cancelAfter: 1, rounds: [{ impact: "all" }] },
  { name: "max-items-zero-default", rounds: [{ maxItems: 0, impact: "all" }] },
  { name: "max-items-negative-clamps", rounds: [{ maxItems: -1, impact: "all" }] },
];
function files(store) {
  const out = Object.fromEntries(keys.map(key => [key, readRows(store.paths[key])]));
  const manifest = existsSync(store.paths.vectorIndex)
    ? JSON.parse(readFileSync(store.paths.vectorIndex, "utf8")) : null;
  const binary = manifest ? readFileSync(path.join(path.dirname(store.paths.vectorIndex), manifest.file)) : null;
  const vectors = binary ? Array.from({ length: binary.length / 4 }, (_, i) => binary.readFloatLE(i * 4)) : [];
  const recordIndex = existsSync(store.paths.index) ? JSON.parse(readFileSync(store.paths.index, "utf8")) : null;
  return { ...out, manifest, vectors, recordIndex };
}
async function run(spec) {
  const directory = mkdtempSync(path.join(tmpdir(), "neo-drain-recording-"));
  try {
    const store = createNeoStore(directory, workspace);
    if (spec.capture) {
      captureNeoFromAgentEnd({ sessionKey: "stable-session", runId: "run-one", messages },
        { workspaceKey: workspace, agentId: "alpha" }, store);
    } else {
      const target = source("turn-first", "First durable fixture fact");
      const second = source("turn-second", "Second durable fixture fact");
      if (spec.foreign) {
        target.ownerUserId = `user:v2:${"2".repeat(64)}`;
        target.visibility.ownerUserId = target.ownerUserId;
      }
      store.appendTurns([target, second]);
      store.appendEmbeddingQueue([target, second]);
      if (spec.revised) {
        const latest = source("turn-first", "Older timestamp in a later physical row", {
          createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
        });
        writeFileSync(store.paths.turns, readFileSync(store.paths.turns, "utf8") + JSON.stringify(latest) + "\n");
      }
      const queue = readRows(store.paths.embeddings);
      if (spec.status) {
        if (spec.status === "missing") delete queue[0].status;
        else queue[0].status = spec.status;
      }
      if (spec.targetType) queue[0].targetType = spec.targetType;
      if (spec.missingTarget) queue[0].targetId = "absent-target";
      if (spec.mixedImpact) { queue[0].impact = "high"; queue[1].impact = "low"; }
      if (spec.duplicateQueue) queue.push({ ...queue[0] });
      mkdirSync(path.dirname(store.paths.embeddings), { recursive: true });
      writeFileSync(store.paths.embeddings, queue.map(row => JSON.stringify(row) + "\n").join(""));
    }
    const input = files(store);
    const rounds = [];
    for (const round of spec.rounds) {
      const calls = [];
      const controller = new AbortController();
      const provider = round.provider ?? spec.provider ?? "normal";
      const options = { now, dimensions: 3, ...round, signal: controller.signal };
      delete options.provider;
      if (provider !== "none") options.embedder = async (text, target) => {
        calls.push({ text, id: target.id });
        if (spec.cancelAfter && calls.length >= spec.cancelAfter) controller.abort();
        if (provider === "throw") throw new Error("fixture provider refused");
        if (provider === "empty") return [];
        if (provider === "nan") return [NaN, 0, 1];
        if (provider === "wrong-dimensions") return [0.5, 1];
        if (provider === "scalar") return 1;
        return [0.5, -0.25, 1.125];
      };
      const result = await store.drainEmbeddingQueue(options);
      result.queuePath = path.relative(directory, result.queuePath).split(path.sep).join("/");
      rounds.push({ options: round, calls, result, output: files(store) });
    }
    return { spec, workspace, now, input, rounds };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const cases = [];
for (const spec of specifications) {
  const first = await run(spec);
  assert.deepEqual(await run(spec), first, spec.name);
  cases.push(first);
}
const here = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here, "golden/neo-embedding-drain.json"), JSON.stringify({
  provenance: { commit: PIN, node: process.version, sourceHashes: Object.fromEntries(verified) },
  cases,
}, null, 2) + "\n");
console.log(`Recorded ${cases.length} actual Node Neo embedding-drain scenarios twice`);
