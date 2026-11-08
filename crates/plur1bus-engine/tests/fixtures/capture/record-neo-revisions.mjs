// Actual pinned C4 store/curation/audit primitives. This does not emulate the full command runner.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const PIN = "af73288cf2a268213b6e8d4a8151772aa327e29b";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source and Node 24.21.0 required");
const verified = new Map();
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  assert.deepEqual(source, execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 }));
  verified.set(relative, createHash("sha256").update(source).digest("hex"));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const name = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(name)) verify(name);
  }
}
for (const name of ["lib/neo-arch.js", "lib/curation-resolve.js", "lib/sql-safety.js"]) verify(name);
const { createNeoStore, transitionRecordStatus } = await import(pathToFileURL(path.join(root, "lib/neo-arch.js")));
const { resolveCurationRecord } = await import(pathToFileURL(path.join(root, "lib/curation-resolve.js")));
const { appendDestructiveOpLog } = await import(pathToFileURL(path.join(root, "lib/sql-safety.js")));
const now = "2026-11-08T12:00:00.000Z";
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return OriginalDate.parse(now); }
};
const workspace = "workspace-dir:v1:/fixture/workspace";
const read = (file) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
function run() {
  const cases = [];
  for (const origin of ["behavior", "candidates"]) for (const action of ["keep", "drop", "promote", "demote", "prune", "tombstone"]) {
    for (const fresh of [false, true]) {
      const directory = mkdtempSync(path.join(tmpdir(), "neo-revision-recording-"));
      try {
        const store = createNeoStore(directory, workspace);
        const record = { id: origin === "behavior" ? "beh_revision" : "mem_revision", workspaceKey: workspace, agentId: "alpha", scope: "agent_private", ownerUserId: "user:v2:" + createHash("sha256").update("fixture").digest("hex"), status: "conflict", confidence: .5, salience: .4, embeddingStatus: "pending", createdAt: "2026-11-08T10:00:00.000Z", statement: "Synthetic fixture decision", ...(origin === "behavior" ? { sourceSignals: ["reaction-one"] } : { sourceTurnIds: ["turn-one"] }), opaque: { preserved: "\ud800" } };
        const source = fresh ? { ...record, confidence: .15, salience: .15, updatedAt: "2026-11-08T11:00:00.000Z" } : record;
        mkdirSync(path.dirname(store.paths[origin]), { recursive: true });
        writeFileSync(store.paths[origin], [record, ...(fresh ? [source] : [])].map(JSON.stringify).join("\n") + "\n");
        let result;
        const curation = ["keep", "drop"].includes(action);
        if (curation) result = resolveCurationRecord(store, record, action, { authorized: true });
        else result = store.reviseRecord(record.id, current => transitionRecordStatus(current, action === "tombstone" ? "tombstoned" : `${action}d`));
        const audit = { event: curation ? "curation.resolve" : "neo.status_transition", source: curation ? "plur1bus_curation" : "plur1bus_memory", agentId: "alpha", recordId: record.id, action, ...(curation ? {} : {status: result.record.status, store: result.store}), timestamp: now };
        assert.equal(appendDestructiveOpLog(directory, audit), true);
        if (!curation) store.appendEmbeddingQueue([result.record]);
        cases.push({ name: `${origin}-${action}-${fresh ? "fresh" : "initial"}`, origin, action, source, hint: record, now, result, revision: read(store.paths[origin]).at(-1), opposite: read(store.paths[origin === "behavior" ? "candidates" : "behavior"]), queue: read(store.paths.embeddings), audit: read(path.join(directory, ".adaptive-learning/destructive-ops.jsonl")) });
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
  return cases;
}
const cases = run();
assert.deepEqual(run(), cases);
writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "golden/neo-revisions.json"), JSON.stringify({ provenance: { commit: PIN, node: process.version, sourceHashes: Object.fromEntries(verified) }, cases }, null, 2) + "\n");
console.log(`Recorded ${cases.length} actual Node C4 revisions twice`);
