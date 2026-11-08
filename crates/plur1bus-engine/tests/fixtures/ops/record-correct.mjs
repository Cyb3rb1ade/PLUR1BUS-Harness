// RX3: actual MemoryOps.correct, successor rows, graph rewrites and events through real Lance mutations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, "v24.21.0");
const source = JSON.parse(readFileSync(new URL("./write-sources.json", import.meta.url), "utf8"));
const files = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith(".js")) files.push(file); } }
walk(path.join(root, "engine")); walk(path.join(root, "lib"));
const hash = createHash("sha256");
for (const file of files.sort()) { hash.update(`${path.relative(root, file)}\0`); hash.update(readFileSync(file)); hash.update("\0"); }
assert.equal(hash.digest("hex"), source.treeSha256);
const load = file => import(pathToFileURL(path.join(root, file)));
const { createMemoryWrite } = await load("engine/memory-ops/write.js");
const { createMemoryOpsContext } = await load("engine/memory-ops/context.js");
const { MemoryDB } = await load("engine/store/memory-db.js");
const { createDbAdapter } = await load("lib/db-adapter.js");
const now = 1_800_000_000_000;
const NativeDate = Date;
globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
const memoryId = "00000000-0000-4000-8000-000000000001";
const principal = { agentId: "agent", workspace: "workspace:v1:fixture", channel: "", accountId: "", chat: { id: "", kind: "direct" }, trust: "inferred" };
const agent = { origin: "user", background: false };
const definitions = [
  { name: "correct-version", newText: "Corrected synthetic card" },
  { name: "trusted-collapse", newText: "Corrected trusted card", fields: { epistemicStatus: "trusted", epistemicStatusActor: "fixture", epistemicStatusReason: "manual", epistemicStatusUpdatedAt: now-100, validFrom: now-2000, validUntil: now+2000 } },
  { name: "untrusted-retained", newText: "Corrected untrusted card", fields: { epistemicStatus: "untrusted" } },
  { name: "permanence-retained", newText: "Corrected permanent card", fields: { importance: .96, neverForget: 1, memoryClass: "core", coreMemoryReason: "fixture" } },
  { name: "summary-utf16", newText: "a".repeat(199) + "😀 tail\nsecond line" },
  { name: "trimmed", newText: "  Corrected synthetic card  " },
  { name: "blank", newText: " \t\n " },
  { name: "too-long", newText: "😀".repeat(4001) },
  { name: "foreign-hidden", newText: "Corrected", foreign: true },
  { name: "deleted-hidden", newText: "Corrected", deleted: true },
  { name: "background-denied", newText: "Corrected", context: { ...agent, background: true } },
  { name: "system-denied", newText: "Corrected", context: { ...agent, origin: "system" } },
  { name: "invalid-id", newText: "Corrected", id: "invalid" },
  { name: "missing-id", newText: "Corrected", id: "00000000-0000-4000-8000-000000000099" },
  { name: "archive-failure", newText: "Corrected", archiveFailure: true },
  { name: "embed-failure", newText: "Corrected", embedFailure: true },
  { name: "audit-failure", newText: "Corrected", auditFailure: true },
  { name: "workspace-required", newText: "Corrected", noWorkspace: true },
  { name: "neo-unavailable", newText: "Corrected", noNeo: true },
  { name: "event-read-failure", newText: "Corrected", eventReadFailure: true },
  { name: "event-write-failure", newText: "Corrected", eventWriteFailure: true },
  { name: "edge-read-failure", newText: "Corrected", edgeReadFailure: true },
];
async function record() {
  const cases = [];
  for (const definition of definitions) {
    const work = mkdtempSync(path.join(tmpdir(), "rx3-correct-"));
    const baseDbPath = path.join(work, "store");
    const workspace = path.join(work, "workspace");
    mkdirSync(workspace);
    const stateDir = path.join(work, "state");
    const db = new MemoryDB(path.join(baseDbPath, "agent"), 4);
    const adapter = createDbAdapter({ basePath: baseDbPath, getTable: async () => db.table });
    try {
      await db.init();
      await db.store({ id: memoryId, text: "Synthetic forgotten card", summary: "Synthetic summary", vector: [1,0,0,0], createdAt: now - 1000, agentId: definition.foreign ? "foreign" : "agent", storedBy: definition.foreign ? "foreign" : "agent", scope: "agent-private", status: definition.deleted ? "deleted" : "active", epistemicStatus: "observed", origin: "note", category: "fact", importance: 0.5, ...definition.fields });
      const original = JSON.parse(JSON.stringify((await db.table.query().toArray())[0], (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
      const opsContext = createMemoryOpsContext({ host: { stateDir, workspaceDir: async () => definition.noWorkspace ? "" : workspace } });
      const pool = { withDb: async (_agent, fn) => fn(db), withReadDbs: async (_agent, fn) => fn([{ db, namespace: null }]) };
      const sharedMemoryPool = { withWorkspaceReadDb: async (_ctx, fn) => fn(null), withUserReadDb: async (_ctx, fn) => fn(null) };
      const events = [], edgeWrites = [], embeddingCalls = [];
      const neo = {
        readReconsolidationEvents: async () => { if (definition.eventReadFailure) throw new Error("fixture"); return events; },
        appendReconsolidationEvents: async rows => { if (definition.eventWriteFailure) throw new Error("fixture"); events.push(...rows); },
        readGraphEdges: async () => { if (definition.edgeReadFailure) throw new Error("fixture"); return [{source:memoryId,target:"synthetic-peer",kind:"related",weight:.5},{source:"synthetic-peer",target:memoryId,kind:"related",weight:.3}]; },
        appendGraphEdges: async rows => edgeWrites.push(...rows),
      };
      const embeddings = { embed: async text => { embeddingCalls.push(text); if (definition.embedFailure) throw new Error("fixture"); return [0,1,0,0]; } };
      const ops = createMemoryWrite({ opsContext, pool, sharedMemoryPool, memoryDbAdapter: adapter, baseDbPath, embeddings, getNeoStore: () => definition.noNeo ? undefined : neo });
      if (definition.archiveFailure) { mkdirSync(path.join(stateDir, "memory"), { recursive: true }); writeFileSync(path.join(stateDir, "memory", "_archive"), "blocked"); }
      if (definition.auditFailure) writeFileSync(path.join(workspace, ".adaptive-learning"), "blocked");
      const results = [];
      const invoke = async () => { try { results.push({ value: await ops.correct(definition.id ?? memoryId, definition.newText, principal, definition.context ?? agent) }); } catch (e) { assert.equal(typeof e.code, "string"); results.push({ error: e.code }); } };
      await invoke();
      if (definition.repeat) { if (definition.auditFailure) rmSync(path.join(workspace, ".adaptive-learning")); await invoke(); }
      const registryPath = path.join(work, "_tombstones", "agent.jsonl");
      const registry = existsSync(registryPath) ? readFileSync(registryPath, "utf8").trim().split("\n").map(JSON.parse) : [];
      const archiveRoot = path.join(stateDir, "memory", "_archive", "agent");
      const archives = existsSync(archiveRoot) ? readdirSync(archiveRoot).sort().map(file => ({ file, card: JSON.parse(readFileSync(path.join(archiveRoot, file), "utf8")) })) : [];
      const auditPath = path.join(workspace, ".adaptive-learning", "destructive-ops.jsonl");
      const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8").trim().split("\n").map(JSON.parse) : [];
      const rows = JSON.parse(JSON.stringify(await db.table.query().toArray(), (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
      const ids = new Map();
      function normalize(value, key = "") {
        if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) && value !== memoryId && value !== definition.id) { if (!ids.has(value)) ids.set(value, `generated-${ids.size + 1}`); return ids.get(value); }
        if (typeof value === "string") return value.replaceAll(work, "<work>");
        if (Array.isArray(value)) return value.map(item => normalize(item));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,normalize(v,k)]));
        return value;
      }
      cases.push(normalize({ ...definition, original, results, rows, archives, registry, audit, events, edgeWrites, embeddingCalls }));
    } finally { await adapter.shutdown(); await db.shutdown(); rmSync(work, { recursive: true, force: true }); }
  }
  return cases;
}
const cases = await record(); assert.deepEqual(await record(), cases);
writeFileSync(new URL("./golden/correct.json", import.meta.url), `${JSON.stringify({ recordedFrom: { engine: "node", source, node: process.version }, now, principal, agent, cases }, null, 2)}\n`);
console.log(`Recorded ${cases.length} correct cases twice through actual Node and Lance`);
