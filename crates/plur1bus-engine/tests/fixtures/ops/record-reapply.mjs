// RX4/S5b: actual committed-tombstone reapply, registry and LanceDB; faults only at explicit adapter boundaries.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, "v24.21.0");
const source = JSON.parse(readFileSync(new URL("./s5-sources.json", import.meta.url), "utf8"));
const files = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith(".js")) files.push(file); } }
walk(path.join(root, "engine")); walk(path.join(root, "lib"));
const hash = createHash("sha256");
for (const file of files.sort()) { hash.update(`${path.relative(root, file)}\0`); hash.update(readFileSync(file)); hash.update("\0"); }
assert.equal(hash.digest("hex"), source.treeSha256);
const load = file => import(pathToFileURL(path.join(root, file)));
const { reapplyCommittedTombstones, reapplyFailed } = await load("lib/tombstone-reapply.js");
const { buildTombstone, appendTombstoneToRegistry } = await load("lib/tombstone.js");
const { MemoryDB } = await load("engine/store/memory-db.js");
const { createDbAdapter } = await load("lib/db-adapter.js");
const now = 1_800_000_000_000;
const NativeDate = Date;
globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
const memoryId = "00000000-0000-4000-8000-000000000001";
const definitions = [
  ...["active", "deleted", "archived", "superseded", ""].flatMap(status => [true, false].map(apply => ({name: `${status || "legacy-empty"}-${apply ? "apply" : "preview"}`, status, apply}))),
  ...[true, false].map(apply => ({name: `missing-row-${apply}`, apply, missingRow: true})),
  ...[true, false].map(apply => ({name: `missing-store-${apply}`, apply, missingStore: true})),
  ...["attempted", "failed"].map(registryStatus => ({name: `${registryStatus}-ignored`, apply: true, registryStatus})),
  {name: "duplicate-committed", apply: true, duplicate: true},
  {name: "corrupt-line", apply: true, corrupt: true},
  {name: "torn-tail-apply", apply: true, torn: true},
  {name: "torn-tail-preview", apply: false, torn: true},
  {name: "write-error", apply: true, writeError: true},
  {name: "verify-error", apply: true, verifyError: true},
  {name: "false-write-success", apply: true, writeNoop: true},
  {name: "invalid-registry-filename", apply: true, invalidAgent: true},
];
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
async function record() {
  const cases = [];
  for (const definition of definitions) {
    const work = mkdtempSync(path.join(tmpdir(), "rx4-reapply-"));
    const baseDbPath = path.join(work, "store");
    const db = definition.missingStore ? null : new MemoryDB(path.join(baseDbPath, "agent"), 4);
    try {
      if (db) {
        await db.init();
        if (!definition.missingRow) {
          await db.store({id: memoryId, text: "Synthetic restored memory", summary: "Synthetic summary", vector: [1,0,0,0], createdAt: now - 1000, updatedAt: now - 500, agentId: "agent", storedBy: "agent", scope: "agent-private", status: definition.status || "active", epistemicStatus: "observed", origin: "note", category: "fact", importance: .5});
          if (definition.status === "") await db.table.update({where: `id = '${memoryId}'`, values: {status: ""}});
        }
      }
      const getRow = async () => db ? plain((await db.table.query().where(`id = '${memoryId}'`).toArray())[0] ?? null) : null;
      const original = await getRow();
      const tombstone = {...buildTombstone({agentId: "agent", card: {id: memoryId, text: "Synthetic restored memory", scope: "agent-private"}, deletedAt: new Date(now).toISOString()}), tombstoneId: "00000000-0000-4000-8000-000000000002", status: definition.registryStatus ?? "committed"};
      let file = appendTombstoneToRegistry(baseDbPath, "agent", tombstone);
      if (definition.duplicate) appendTombstoneToRegistry(baseDbPath, "agent", {...tombstone, tombstoneId: "00000000-0000-4000-8000-000000000003"});
      if (definition.corrupt || definition.torn) writeFileSync(file, readFileSync(file, "utf8") + (definition.corrupt ? "invalid-line\n" : '{"cut":'));
      if (definition.invalidAgent) {
        const renamed = path.join(path.dirname(file), "bad agent.jsonl");
        writeFileSync(renamed, readFileSync(file)); rmSync(file); file = renamed;
      }
      const before = readFileSync(file, "utf8");
      const adapterFactory = () => {
        const adapter = createDbAdapter({basePath: baseDbPath, getTable: async () => db?.table});
        if (definition.writeError) adapter.tombstoneCard = async () => {throw new Error("storage");};
        if (definition.writeNoop) adapter.tombstoneCard = async () => ({ok: true});
        if (definition.verifyError) adapter.getCardRaw = async () => {throw new Error("storage");};
        return adapter;
      };
      const report = await reapplyCommittedTombstones({baseDbPath, apply: definition.apply, adapterFactory});
      const row = await getRow();
      const after = readFileSync(file, "utf8");
      const second = await reapplyCommittedTombstones({baseDbPath, apply: definition.apply, adapterFactory});
      cases.push({...definition, original, before, report, failed: reapplyFailed(report), row, after, second, secondFailed: reapplyFailed(second), secondRow: await getRow()});
    } finally { if (db) await db.shutdown(); rmSync(work, {recursive: true, force: true}); }
  }
  return cases;
}
const cases = await record(); assert.deepEqual(await record(), cases);
writeFileSync(new URL("./golden/reapply.json", import.meta.url), `${JSON.stringify({recordedFrom: {engine: "node", source, node: process.version}, now, cases}, null, 2)}\n`);
console.log(`Recorded ${cases.length} actual Node/Lance reapply cases twice, with independent verification and repeat execution`);
