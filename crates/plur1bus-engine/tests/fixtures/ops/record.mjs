// RX3/RE-07: read operations through the pinned Node exports and real Lance tables.
// Run in Node 24.21 with PLUR1BUS_ENGINE_SRC pointing to the immutable pin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, statSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root);
assert.equal(process.version, "v24.21.0");
const sources = JSON.parse(readFileSync(new URL("./read-sources.json", import.meta.url), "utf8"));
for (const [file, expected] of Object.entries(sources.sha256)) {
  assert.equal(createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"), expected, file);
}
const load = file => import(pathToFileURL(path.join(root, file)));
const { createMemoryRead } = await load("engine/memory-ops/read.js");
const { createMemoryOpsContext } = await load("engine/memory-ops/context.js");
const { MemoryDB } = await load("engine/store/memory-db.js");
const { createImportLedger } = await load("engine/memory-ops/import-ledger.js");
const { createLinkLedger, linkIdFor } = await load("engine/memory-ops/link-ledger.js");
const now = 1_800_000_000_000;
Date.now = () => now;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const principal = { agentId: "agent", workspace: "workspace:v1:read-fixture", channel: "", accountId: "", chat: { id: "", kind: "direct" }, trust: "inferred" };
const agent = { origin: "user", background: false };
const row = (n, fields = {}) => ({ id: id(n), text: `Synthetic read card ${n}`, summary: `Summary ${n}`, vector: [1, n, 0, 0], agentId: "agent", storedBy: "agent", scope: "agent-private", status: "active", origin: "note", epistemicStatus: "observed", createdAt: now - n * 100, expiresAt: 0, ...fields });
async function record() {
  const work = mkdtempSync(path.join(tmpdir(), "rx3-ops-"));
  const db = new MemoryDB(path.join(work, "store", "agent"), 4);
  try {
    await db.init();
    const inputs = [row(1), row(2), row(3, { status: "deleted" }), row(4, { expiresAt: now }), row(5, { epistemicStatus: "invalidated" }), row(6, { validFrom: now + 100_000 }), row(7, { validUntil: now - 100_000 }), row(8, { agentId: "foreign", storedBy: "foreign" })];
    for (const entry of inputs) await db.store(entry);
    // Capture the actual normalized persisted rows, not a second implementation of defaults.
    const stored = JSON.parse(JSON.stringify(await db.table.query().toArray(), (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
    let closed = false;
    const host = { stateDir: path.join(work, "state"), workspaceDir: async () => path.join(work, "workspace") };
    const opsContext = createMemoryOpsContext({ host, isClosed: () => closed });
    const baseDbPath = path.join(work, "store");
    const importLedger = createImportLedger({ baseDbPath });
    const linkLedger = createLinkLedger({ baseDbPath });
    const ops = createMemoryRead({ opsContext, importLedger, linkLedger, pool: { withReadDbs: async (_agent, fn) => fn([{ db, namespace: null }]) }, sharedMemoryPool: { withWorkspaceReadDb: async (_ctx, fn) => fn(null), withUserReadDb: async (_ctx, fn) => fn(null) }, embeddings: { embedQuery: async () => [1, 0, 0, 0] }, baseDbPath: path.join(work, "store") });
    const cases = [];
    async function capture(name, method, argument, p = principal) {
      const sidecars = {};
      for (const folder of ["_imports", "_links"]) {
        const file = path.join(baseDbPath, folder, "agent.jsonl");
        if (existsSync(file)) sidecars[folder] = statSync(file).isDirectory() ? { directory: true } : { text: readFileSync(file, "utf8") };
      }
      try {
        const value = method === "state" ? await ops.state(p, agent) : await ops[method](argument, p, agent);
        if (method === "state") value.archiveDir = "<state>/memory/_archive";
        cases.push({ name, method, argument, sidecars, principal: p, expected: JSON.parse(JSON.stringify(value)) });
      } catch (error) {
        assert.equal(typeof error.code, "string", String(error));
        cases.push({ name, method, argument, sidecars, principal: p, error: error.code });
      }
    }
    await capture("time-all", "list", { since: 0 });
    await capture("time-limit", "list", { since: 0, limit: 1 });
    await capture("time-bounds", "list", { since: now - 700, until: now - 200 });
    await capture("topic", "list", { topic: "Synthetic", limit: 2 });
    for (const q of [{}, { topic: " ", since: 0 }, { topic: " " }, { topic: "x", until: now }, { since: 10, until: 9 }, { topic: "😀".repeat(1001) }]) await capture("invalid-list", "list", q);
    for (const n of [1, 3, 4, 5, 6, 7, 8, 99]) await capture(`show-${n}`, "show", id(n));
    await capture("invalid-id", "show", "not-an-id");
    await capture("state", "state");
    await capture("invalid-agent", "state", undefined, { ...principal, agentId: "../agent" });
    importLedger.append("agent", { idempotencyKey: "import-one", cardId: id(1), sourceRef: "fixture:first", importedAt: now - 100 });
    await capture("import-provenance", "show", id(1));
    importLedger.append("agent", { idempotencyKey: "import-one", cardId: id(1), sourceRef: "fixture:replacement", importedAt: now });
    const link = sourceRef => ({ kind: "linked", linkId: linkIdFor("agent", id(1), sourceRef), cardId: id(1), sourceRef, provenance: "imported", at: now });
    linkLedger.append("agent", { ...link("fixture:new"), importRunId: "run-one" });
    linkLedger.append("agent", { ...link("fixture:old"), at: now - 100 });
    await capture("links-oldest-first", "show", id(1));
    await capture("list-provenance", "list", { since: 0 });
    linkLedger.append("agent", { kind: "unlinked", linkId: linkIdFor("agent", id(1), "fixture:old"), cardId: id(1), at: now });
    importLedger.append("agent", { kind: "unimported", idempotencyKey: "import-one", cardId: id(1), at: now });
    await capture("removed-provenance", "show", id(1));
    appendFileSync(path.join(baseDbPath, "_links", "agent.jsonl"), 'torn line\n{"v":999}\n');
    await capture("torn-link-keeps-valid-lines", "show", id(1));
    for (const folder of ["_imports", "_links"]) {
      const file = path.join(baseDbPath, folder, "agent.jsonl");
      rmSync(file); mkdirSync(file);
    }
    await capture("unreadable-sidecars-hide-only-provenance", "show", id(1));
    closed = true;
    await capture("closed", "state");
    return { now, principal, agent, stored, cases };
  } finally { await db.shutdown(); rmSync(work, { recursive: true, force: true }); }
}
const first = await record();
assert.deepEqual(await record(), first);
writeFileSync(new URL("./golden/read.json", import.meta.url), `${JSON.stringify({ recordedFrom: { engine: "node", sources, node: process.version }, ...first }, null, 2)}\n`);
console.log(`Recorded ${first.cases.length} read cases twice through actual Node operations and Lance`);
