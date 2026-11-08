// RX3/S5a: real startup reconciler and registry, fixed raw-store adapter responses.
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
const { reconcileAttemptedTombstones } = await import(pathToFileURL(path.join(root, "lib/tombstone-reapply.js")));
const { buildTombstone, appendTombstoneToRegistry, readTombstoneRegistry } = await import(pathToFileURL(path.join(root, "lib/tombstone.js")));
const now = 1_800_000_000_000;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definitions = [
  { name: "deleted-commits", rowStatus: "deleted", age: 1 },
  { name: "active-young-pending", rowStatus: "active", age: 599999 },
  { name: "active-boundary-failed", rowStatus: "active", age: 600000 },
  { name: "active-old-failed", rowStatus: "active", age: 600001 },
  { name: "missing-row", rowStatus: null, age: 600001 },
  { name: "missing-agent-store", missingStore: true, rowStatus: "deleted", age: 600001 },
  { name: "read-error", readError: true, age: 600001 },
  { name: "newer-committed-noop", rowStatus: "deleted", age: 1, later: "committed" },
  { name: "newer-failed-noop", rowStatus: "deleted", age: 1, later: "failed" },
  { name: "another-committed-suppresses-attempt", rowStatus: "deleted", age: 1, otherCommit: true },
  { name: "invalid-date-abandoned", rowStatus: "active", age: 1, invalidDate: true },
  { name: "corrupt-line-refuses", rowStatus: "deleted", age: 1, corrupt: true },
];
async function record() {
  const cases = [];
  for (const [index, definition] of definitions.entries()) {
    const work = mkdtempSync(path.join(tmpdir(), "rx3-reconcile-"));
    const baseDbPath = path.join(work, "lance"); const storeRoot = path.join(work, "generation");
    mkdirSync(baseDbPath);
    if (!definition.missingStore) mkdirSync(path.join(storeRoot, "agent"), { recursive: true });
    try {
      const tombstone = { ...buildTombstone({ agentId: "agent", card: { id: id(index + 1), text: "Synthetic forgotten content", scope: "agent-private" }, deletedAt: definition.invalidDate ? "invalid" : new Date(now - definition.age).toISOString() }), tombstoneId: id(100 + index), status: "attempted" };
      const before = [tombstone];
      if (definition.later) before.push({ ...tombstone, status: definition.later });
      if (definition.otherCommit) before.push({ ...tombstone, tombstoneId: id(200 + index), status: "committed" });
      let file;
      for (const row of before) file = appendTombstoneToRegistry(baseDbPath, "agent", row);
      if (definition.corrupt) writeFileSync(file, `${readFileSync(file, "utf8")}invalid-line\n`);
      const adapter = { getCardRaw: async () => { if (definition.readError) throw new Error("storage"); return definition.rowStatus == null ? null : { status: definition.rowStatus }; } };
      const report = await reconcileAttemptedTombstones({ baseDbPath, storeRoot, adapter, now });
      const after = readTombstoneRegistry(baseDbPath, "agent").tombstones;
      const second = await reconcileAttemptedTombstones({ baseDbPath, storeRoot, adapter, now });
      cases.push({ ...definition, before, report, after, second });
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  return cases;
}
const cases = await record(); assert.deepEqual(await record(), cases);
writeFileSync(new URL("./golden/reconcile.json", import.meta.url), `${JSON.stringify({ recordedFrom: { engine: "node", source, node: process.version }, now, cases }, null, 2)}\n`);
console.log(`Recorded ${cases.length} S5 startup cases twice, including repeat execution`);
