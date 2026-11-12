// RX3: actual MemoryOps.forget, archive, audit and registry through real Lance mutations.
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
  { name: "forget-repeat", repeat: true },
  { name: "deleted-backfill", deleted: true, repeat: true },
  { name: "foreign-deleted-hidden", foreign: true, deleted: true },
  { name: "background-denied", context: { ...agent, background: true } },
  { name: "system-denied", context: { ...agent, origin: "system" } },
  { name: "invalid-id", id: "invalid" },
  { name: "missing-id", id: "00000000-0000-4000-8000-000000000099" },
  { name: "archive-failure", archiveFailure: true },
  { name: "audit-failure-retry", auditFailure: true, repeat: true },
  { name: "workspace-required", noWorkspace: true },
];
async function record() {
  const cases = [];
  for (const definition of definitions) {
    const work = mkdtempSync(path.join(tmpdir(), "rx3-forget-"));
    const baseDbPath = path.join(work, "store");
    const workspace = path.join(work, "workspace");
    mkdirSync(workspace);
    const stateDir = path.join(work, "state");
    const db = new MemoryDB(path.join(baseDbPath, "agent"), 4);
    const adapter = createDbAdapter({ basePath: baseDbPath, getTable: async () => db.table });
    try {
      await db.init();
      await db.store({ id: memoryId, text: "Synthetic forgotten card", summary: "Synthetic summary", vector: [1,0,0,0], createdAt: now - 1000, agentId: definition.foreign ? "foreign" : "agent", storedBy: definition.foreign ? "foreign" : "agent", scope: "agent-private", status: definition.deleted ? "deleted" : "active", epistemicStatus: "observed", origin: "note", category: "fact", importance: 0.5 });
      const original = JSON.parse(JSON.stringify((await db.table.query().toArray())[0], (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
      const opsContext = createMemoryOpsContext({ host: { stateDir, workspaceDir: async () => definition.noWorkspace ? "" : workspace } });
      const pool = { withDb: async (_agent, fn) => fn(db), withReadDbs: async (_agent, fn) => fn([{ db, namespace: null }]) };
      const sharedMemoryPool = { withWorkspaceReadDb: async (_ctx, fn) => fn(null), withUserReadDb: async (_ctx, fn) => fn(null) };
      const ops = createMemoryWrite({ opsContext, pool, sharedMemoryPool, memoryDbAdapter: adapter, baseDbPath, embeddings: {} });
      if (definition.archiveFailure) { mkdirSync(path.join(stateDir, "memory"), { recursive: true }); writeFileSync(path.join(stateDir, "memory", "_archive"), "blocked"); }
      if (definition.auditFailure) writeFileSync(path.join(workspace, ".adaptive-learning"), "blocked");
      const results = [];
      const invoke = async () => { try { results.push({ value: await ops.forget(definition.id ?? memoryId, principal, definition.context ?? agent) }); } catch (e) { assert.equal(typeof e.code, "string"); results.push({ error: e.code }); } };
      await invoke();
      if (definition.repeat) { if (definition.auditFailure) rmSync(path.join(workspace, ".adaptive-learning")); await invoke(); }
      const registryPath = path.join(work, "_tombstones", "agent.jsonl");
      const registry = existsSync(registryPath) ? readFileSync(registryPath, "utf8").trim().split("\n").map(JSON.parse) : [];
      const archiveRoot = path.join(stateDir, "memory", "_archive", "agent");
      const archives = existsSync(archiveRoot) ? readdirSync(archiveRoot).sort().map(file => ({ file, card: JSON.parse(readFileSync(path.join(archiveRoot, file), "utf8")) })) : [];
      const auditPath = path.join(workspace, ".adaptive-learning", "destructive-ops.jsonl");
      const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8").trim().split("\n").map(JSON.parse) : [];
      const row = JSON.parse(JSON.stringify((await db.table.query().toArray())[0], (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
      const ids = new Map();
      function normalize(value, key = "") {
        if (key === "tombstoneId" && typeof value === "string") { if (!ids.has(value)) ids.set(value, `tombstone-${ids.size + 1}`); return ids.get(value); }
        if (typeof value === "string") return value.replaceAll(work, "<work>");
        if (Array.isArray(value)) return value.map(item => normalize(item));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,normalize(v,k)]));
        return value;
      }
      cases.push(normalize({ ...definition, original, results, row, archives, registry, audit }));
    } finally { await adapter.shutdown(); await db.shutdown(); rmSync(work, { recursive: true, force: true }); }
  }
  return cases;
}
const cases = await record(); assert.deepEqual(await record(), cases);
writeFileSync(new URL("./golden/forget.json", import.meta.url), `${JSON.stringify({ recordedFrom: { engine: "node", source, node: process.version }, now, principal, agent, cases }, null, 2)}\n`);
console.log(`Recorded ${cases.length} forget cases twice through actual Node and Lance`);
