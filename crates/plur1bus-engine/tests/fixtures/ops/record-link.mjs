// RX3: actual MemoryOps.link classification, receipts, audit and unchanged Lance cards.
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
const { createMemoryLink } = await load("engine/memory-ops/link.js");
const { createImportLedger } = await load("engine/memory-ops/import-ledger.js");
const { createMemoryOpsContext } = await load("engine/memory-ops/context.js");
const { MemoryDB } = await load("engine/store/memory-db.js");
const now = 1_800_000_000_000;
const NativeDate = Date;
globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
const memoryId = "00000000-0000-4000-8000-000000000001";
const principal = { agentId: "agent", workspace: "workspace:v1:fixture", channel: "", accountId: "", chat: { id: "", kind: "direct" }, trust: "inferred" };
const agent = { origin: "system", background: false };
const request = { sourceRef: "fixture:source;run=run-1", provenance: "imported" };
const definitions = [
  { name: "link-repeat", repeat: true },
  { name: "dry-run-no-write", request: { dryRun: true } },
  { name: "trimmed-source-key", request: { sourceRef: "  fixture:source  ", idempotencyKey: "  imported-key  " } },
  { name: "explicit-run", request: { importRunId: "explicit_2" }, repeat: true },
  { name: "repeated-run", request: { sourceRef: "fixture:source;run=same;run=same" } },
  { name: "conflicting-run", request: { sourceRef: "fixture:source;run=one;run=two" } },
  { name: "malformed-inferred-run", request: { sourceRef: "fixture:source;run=not allowed" } },
  { name: "cap-inferred-run", request: { sourceRef: "x".repeat(493) + ";run=ok" } },
  { name: "explicit-run-invalid", request: { importRunId: "not allowed" } },
  { name: "explicit-run-empty", request: { importRunId: "" } },
  { name: "empty-source", request: { sourceRef: "  " } },
  { name: "source-too-long", request: { sourceRef: "😀".repeat(251) } },
  { name: "empty-key", request: { idempotencyKey: " " } },
  { name: "key-too-long", request: { idempotencyKey: "é".repeat(257) } },
  { name: "already-source", ownSource: true },
  { name: "already-source-dry", ownSource: true, request: { dryRun: true } },
  { name: "last-link-wins", seed: "replaced", repeat: true },
  { name: "unlinked-can-relink", seed: "unlinked", repeat: true },
  { name: "link-cap", seed: "cap" },
  { name: "foreign-hidden", foreign: true },
  { name: "deleted-hidden", deleted: true },
  { name: "expired-hidden", expired: true },
  { name: "missing-hidden", id: "00000000-0000-4000-8000-000000000099" },
  { name: "invalid-id", id: "invalid" },
  { name: "user-denied", context: { origin: "user", background: false } },
  { name: "background-denied", context: { origin: "system", background: true } },
  { name: "without-workspace", noWorkspace: true },
  { name: "audit-failure", auditFailure: true, repeat: true },
  { name: "ledger-unreadable", ledgerFailure: true },
  { name: "import-ledger-unreadable", importFailure: true },
];
async function record() {
  const cases = [];
  for (const definition of definitions) {
    const work = mkdtempSync(path.join(tmpdir(), "rx3-link-"));
    const baseDbPath = path.join(work, "store");
    const workspace = path.join(work, "workspace"); mkdirSync(workspace);
    const db = new MemoryDB(path.join(baseDbPath, "agent"), 4);
    try {
      await db.init();
      await db.store({ id: memoryId, text: "Synthetic linked card", summary: "Synthetic summary", vector: [1,0,0,0], createdAt: now - 1000, expiresAt: definition.expired ? now - 1 : 0, agentId: definition.foreign ? "foreign" : "agent", storedBy: definition.foreign ? "foreign" : "agent", scope: "agent-private", status: definition.deleted ? "deleted" : "active", epistemicStatus: "observed", origin: "note", category: "fact", importance: 0.5 });
      const readRow = async () => JSON.parse(JSON.stringify((await db.table.query().toArray())[0], (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
      const original = await readRow();
      const opsContext = createMemoryOpsContext({ host: { stateDir: path.join(work, "state"), workspaceDir: async () => definition.noWorkspace ? "" : workspace } });
      const pool = { withDb: async (_agent, fn) => fn(db), withReadDbs: async (_agent, fn) => fn([{ db, namespace: null }]) };
      const sharedMemoryPool = { withWorkspaceReadDb: async (_ctx, fn) => fn(null), withUserReadDb: async (_ctx, fn) => fn(null) };
      const importLedger = createImportLedger({ baseDbPath });
      const ops = createMemoryLink({ opsContext, pool, sharedMemoryPool, baseDbPath, importLedger });
      const req = { ...request, ...definition.request };
      const linkPath = path.join(baseDbPath, "_links", "agent.jsonl");
      const importPath = path.join(baseDbPath, "_imports", "agent.jsonl");
      const seededLinks = [];
      const linkId = createHash("sha256").update(`plur1bus.memory.link.v1\0agent\0${memoryId}\0${req.sourceRef.trim()}`).digest("hex").slice(0,32);
      if (definition.ownSource) importLedger.append("agent", { idempotencyKey: "own-key", cardId: memoryId, sourceRef: req.sourceRef, at: now - 100 });
      if (definition.seed === "replaced" || definition.seed === "unlinked") {
        seededLinks.push({ v:1, kind:"linked", linkId, cardId:memoryId, sourceRef:req.sourceRef, provenance:"imported", importRunId:"old-run", at:now-100 });
        seededLinks.push(definition.seed === "unlinked" ? {v:1,kind:"unlinked",linkId,cardId:memoryId,importRunId:"old-run",at:now-50} : {...seededLinks[0],importRunId:"latest-run",at:now-50});
      }
      if (definition.seed === "cap") for(let i=0;i<100;i++) seededLinks.push({v:1,kind:"linked",linkId:`seed-${i}`,cardId:memoryId,sourceRef:`fixture:seed-${i}`,provenance:"imported",at:now-i});
      if(seededLinks.length) { mkdirSync(path.dirname(linkPath),{recursive:true}); writeFileSync(linkPath,seededLinks.map(row=>JSON.stringify(row)).join("\n")+"\n"); }
      if(definition.auditFailure) writeFileSync(path.join(workspace,".adaptive-learning"),"blocked");
      for (const [enabled, file] of [[definition.ledgerFailure,linkPath],[definition.importFailure,importPath]]) if(enabled) mkdirSync(file,{recursive:true});
      const results=[];
      for(let i=0;i<(definition.repeat?2:1);i++) {
        try { results.push({value:await ops.link(definition.id??memoryId,req,principal,definition.context??agent)}); }
        catch(e) { assert.equal(typeof e.code,"string"); results.push({error:e.code}); }
      }
      const auditPath=path.join(workspace,".adaptive-learning","destructive-ops.jsonl");
      const readLines=file=>existsSync(file)?readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse):[];
      const links=definition.ledgerFailure?[]:readLines(linkPath);
      const imports=definition.importFailure?[]:readLines(importPath);
      const audit=definition.auditFailure?[]:readLines(auditPath);
      assert.deepEqual(await readRow(),original,"link must never modify the card row");
      cases.push({...definition,request:req,original,seededLinks,imports,results,links,audit});
    } finally { await db.shutdown(); rmSync(work,{recursive:true,force:true}); }
  }
  return cases;
}
const cases=await record(); assert.deepEqual(await record(),cases);
writeFileSync(new URL("./golden/link.json",import.meta.url),JSON.stringify({recordedFrom:{engine:"node",source,node:process.version},now,principal,agent,cases},null,2)+"\n");
console.log(`Recorded ${cases.length} link cases twice through actual Node and Lance`);
