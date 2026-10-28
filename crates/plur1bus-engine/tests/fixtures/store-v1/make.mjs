#!/usr/bin/env node
// RE-02 fixtures recorded from engine commit 9f34008c143c5da87b2194b5a28442b407ff8ba7.
// Run after pnpm test:prep: node crates/plur1bus-engine/tests/fixtures/store-v1/make.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(fixtureDir, "../../../../..");
const corePackage = path.join(repo, "packages/core/package.json");
const requireFromCore = createRequire(corePackage);
const specification = JSON.parse(readFileSync(corePackage)).dependencies["@cyb3rb1ade/plur1bus-memory"];
assert.ok(specification.endsWith(PIN) && !/^(file:|link:)/.test(specification), "engine dependency must use the exact recorded pin");
assert.ok(readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8").includes(PIN), "frozen lockfile must contain the recorded pin");
let engineRoot;
try { engineRoot = path.dirname(requireFromCore.resolve("@cyb3rb1ade/plur1bus-memory/package.json")); }
catch { throw new Error("run pnpm test:prep (the engine package is not installed)"); }
const resolvedEngine = realpathSync(engineRoot);
const relativeEngine = path.relative(realpathSync(path.join(repo, "node_modules")), resolvedEngine);
assert.ok(!path.isAbsolute(relativeEngine) && !relativeEngine.startsWith(`..${path.sep}`) && relativeEngine.startsWith(`.pnpm${path.sep}`), "installed engine must come from the frozen workspace install, without a file/link override");
// A Windows checkout may convert the committed lockfile to CRLF; pnpm writes its install copy with LF.
const lockfile = (file) => readFileSync(path.join(repo, file), "utf8").replace(/\r\n/g, "\n");
assert.equal(lockfile("node_modules/.pnpm/lock.yaml"), lockfile("pnpm-lock.yaml"), "installed and committed lockfiles must agree");
if (!process.version.startsWith("v24.21.")) throw new Error(`expected Node 24.21.x, got ${process.version}`);
const engineImport = (file) => import(pathToFileURL(path.join(engineRoot, file)).href);
const { MemoryDB } = await engineImport("engine/store/memory-db.js");
const { writeStoreSchemaMarker } = await engineImport("engine/store/schema-version.js");
const NOW = Date.UTC(2026, 0, 13, 12);
const vector = () => Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
const flat = { embed: async () => vector(), embedQuery: async () => vector(), embedPassage: async () => vector(), embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
function schemaText(schema) {
  const neutralTypes = { Utf8: "Utf8", Bool: "Boolean", Float64: "Float64", "FixedSizeList[384]<Float32>": "FixedSizeList[384]<Float32>" };
  return schema.fields.map((field) => {
    const type = neutralTypes[String(field.type)];
    assert.ok(type, `unrecorded Arrow type ${field.type}`);
    return `${field.name}\t${type}\t${field.nullable}`;
  }).join("\n") + "\n";
}
async function fullSchemaText(db) {
  const metadata = await db.db.openTable("_embedding_identity");
  try { return `[memories]\n${schemaText(await db.table.schema())}[_embedding_identity]\n${schemaText(await metadata.schema())}`; }
  finally { await metadata.close(); }
}
async function dump(directory) {
  const db = new MemoryDB(directory, 384, null, { readOnly: true });
  await db.init();
  try {
    const rows = (await db.table.query().toArray()).map((entry) => Object.fromEntries((awaitSchemaFields).map((name) => [name, entry[name]])));
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return { rows, schema: await fullSchemaText(db) };
  } finally { await db.shutdown(); }
}
const awaitSchemaFields = Object.keys(JSON.parse(readFileSync(path.join(repo, "crates/plur1bus-engine/schema/engine-contract.schema.json"))).$defs.MemoryRow.properties).filter((name) => name !== "vector");
const sizeOf = (directory) => readdirSync(directory, { withFileTypes: true }).reduce((size, entry) => size + (entry.isDirectory() ? sizeOf(path.join(directory, entry.name)) : statSync(path.join(directory, entry.name)).size), 0);
const appendAt = process.argv.indexOf("--append");
if (appendAt !== -1) {
  const directory = path.resolve(process.argv[appendAt + 1]);
  const db = new MemoryDB(directory, 384);
  await db.init();
  try {
    for (let i = 0; i < 5; i++) await db.store({ id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, text: `Node appended deterministic fact ${i + 1}.`, vector: vector(), importance: .5, category: "general", createdAt: NOW + i, agentId: "a2", storedBy: "a2" });
  } finally { await db.shutdown(); }
} else if (process.argv.includes("--dump")) {
  console.log(JSON.stringify(await dump(process.argv[process.argv.indexOf("--dump") + 1] || fixtureDir)));
} else {
  const surrogate = process.argv.includes("--surrogate");
  const destination = surrogate ? path.join(fixtureDir, "../store-surrogate") : fixtureDir;
  const temp = mkdtempSync(path.join(tmpdir(), "re02-record-"));
  const base = path.join(temp, "base");
  const workspace = path.join(temp, "workspace");
  mkdirSync(workspace);
  const originalNow = Date.now;
  const originalUuid = crypto.randomUUID;
  let sequence = 0;
  // The pinned capture port still calls Date.now/randomUUID internally. Freeze those recorder-only inputs too.
  Date.now = () => NOW;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  syncBuiltinESMExports();
  let engine;
  try {
    const { createEngine } = await engineImport("engine/create-engine.js");
    const platform = await engineImport("lib/platform.js");
    const host = { stateDir: path.join(temp, "state"), workspaceDir: async () => workspace, clock: () => NOW, config: () => ({}), configPath: () => path.join(temp, "config.json"), logger: Object.fromEntries(["info", "warn", "error", "debug"].map((name) => [name, () => {}])), platform };
    engine = createEngine(host, { baseDbPath: base, embedding: { provider: "local-transformers", local: { dimensions: 384 } }, duplicateThreshold: 1.01, captureMaxChars: surrogate ? 201 : 15000, autoCapture: true, neo: { enabled: false }, gc: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, obsidianBridge: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } }, { internals: { embeddings: flat, reranker: null } });
    const total = surrogate ? 1 : 12;
    for (let i = 0; i < total; i++) {
      const agentId = i < 8 ? "a1" : "a2";
      const text = surrogate ? `${"A".repeat(200)}🚀 I have decided to store this durable project fact.` : `I have decided that project fixture item ${i + 1} uses the durable archive policy number ${i + 1}.`;
      const result = await engine.capture({ turnId: `fixture-turn-${i}`, agentId, principal: { agentId, channel: "fixture", accountId: "fixture", trust: "proved", user: `user:v1:${"a".repeat(64)}` }, agent: { origin: "user", background: false }, messages: [{ role: "user", content: text }], sessionKey: `agent:${agentId}:main`, incognito: false, signal: AbortSignal.timeout(20000) }).done;
      assert.equal(result.stored, 1, JSON.stringify(result));
    }
    if (!surrogate) {
      const agentId = "a2";
      const principal = { agentId, channel: "fixture", accountId: "fixture", trust: "proved", user: `user:v1:${"a".repeat(64)}`, chat: { id: "fixture", kind: "direct" } };
      const actor = { origin: "user", background: false };
      const listed = await engine.memory.list({ topic: "item 11" }, principal, actor);
      const forgotten = listed.items.find((row) => row.text.includes("item 11 "));
      assert.ok(forgotten, "eleventh captured row is visible before forgetting");
      const result = await engine.memory.forget(forgotten.id, principal, actor);
      assert.equal(result.archived, true);
    }
    await engine.close();
    engine = null;
    const captured = [];
    let identity;
    for (const agentId of surrogate ? ["a1"] : ["a1", "a2"]) {
      const db = new MemoryDB(path.join(base, agentId), 384, null, { readOnly: true });
      await db.init();
      const rows = await db.table.query().toArray();
      identity = db.identity;
      for (const raw of rows) {
        const row = Object.fromEntries(Object.keys(JSON.parse(readFileSync(path.join(repo, "crates/plur1bus-engine/schema/engine-contract.schema.json"))).$defs.MemoryRow.properties).map((name) => [name, name === "vector" ? Array.from(raw.vector) : raw[name]]));
        row.agentId = agentId;
        captured.push(row);
      }
      await db.shutdown();
    }
    // One composite physical fixture preserves rows from both per-agent capture stores.
    captured.sort((a, b) => a.id.localeCompare(b.id));
    if (!surrogate) {
      for (const row of captured.slice(6, 8)) { row.scope = "workspace"; row.workspaceId = `workspace:v1:${"b".repeat(64)}`; }
      for (const row of captured.slice(8, 10)) { row.scope = "user"; row.ownerUserId = `user:v1:${"a".repeat(64)}`; }
      captured[11].memoryKind = "reminder";
      captured[11].remindAt = NOW + 3600000;
    }
    const output = path.join(temp, "output");
    const db = new MemoryDB(output, 384, null, { identity });
    await db.init();
    for (const row of captured) await db.store(row);
    await db.table.optimize({ cleanupOlderThan: new Date(NOW + 86400000), deleteUnverified: true });
    const schema = await fullSchemaText(db);
    await db.shutdown();
    writeStoreSchemaMarker(output, "1", { engineVersion: "fixture-9f34008c", clock: () => NOW });
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(destination)) if (entry !== "make.mjs") rmSync(path.join(destination, entry), { recursive: true, force: true });
    cpSync(output, destination, { recursive: true });
    writeFileSync(path.join(destination, "schema.txt"), schema);
    writeFileSync(path.join(destination, "identity.json"), JSON.stringify(identity, null, 2) + "\n");
    const bytes = sizeOf(destination);
    assert.ok(bytes < 1000000, `fixture too large: ${bytes}`);
    console.log(`${path.basename(destination)}: ${captured.length} rows, ${bytes} bytes`);
  } finally {
    await engine?.close();
    Date.now = originalNow;
    crypto.randomUUID = originalUuid;
    syncBuiltinESMExports();
    rmSync(temp, { recursive: true, force: true });
  }
}
