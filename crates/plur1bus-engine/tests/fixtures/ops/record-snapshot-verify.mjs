// RX4: actual Node snapshot verification; synthetic payloads only, no store or model calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, "v24.21.0");
const source = JSON.parse(readFileSync(new URL("./guards-sources.json", import.meta.url), "utf8"));
const files = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith(".js")) files.push(file); } }
walk(path.join(root, "engine")); walk(path.join(root, "lib"));
const hash = createHash("sha256");
for (const file of files.sort()) { hash.update(`${path.relative(root, file)}\0`); hash.update(readFileSync(file)); hash.update("\0"); }
assert.equal(hash.digest("hex"), source.treeSha256);
const { verifySnapshot } = await import(pathToFileURL(path.join(root, "lib/snapshot/store-snapshot.js")));
const payload = "Synthetic snapshot payload";
const sha = text => createHash("sha256").update(text).digest("hex");
const entry = (path = "store/data.bin", bytes = payload) => ({path, bytes: Buffer.byteLength(bytes), sha256: sha(bytes)});
const standard = () => ({schema: "plur1bus.snapshot/1", id: "ignored-manifest-id", createdAt: "2026-11-08T00:00:00.000Z", label: null, pluginVersion: null, baseDbPath: "/synthetic/store", contents: ["store"], bytes: Buffer.byteLength(payload), fileCount: 1, files: [entry()]});
const definitions = [
  {name: "valid"}, {name: "empty", empty: true},
  {name: "extra-metadata", metadata: {future: {opaque: "retained"}, fileCount: 999}},
  {name: "metadata-byte-coercion", metadata: {bytes: "0x10"}},
  {name: "metadata-nan-is-zero", metadata: {bytes: "not-a-number"}},
  {name: "metadata-negative", metadata: {bytes: -7}},
  ...["inf", "-inf", "INF", "Infinity", "+Infinity", "-Infinity", "infinity"].map(bytes => ({name: `metadata-${bytes}`, metadata: {bytes}})),
  {name: "wrong-schema", metadata: {schema: "plur1bus.snapshot/2"}},
  {name: "invalid-json", raw: '{"private-fixture":'},
  {name: "duplicate-json-last-schema-wins", duplicateSchema: true},
  {name: "missing-manifest", missingManifest: true},
  {name: "missing-payload", missingPayload: true},
  {name: "unlisted-payload", extraPayload: true},
  {name: "changed-payload", changed: true},
  {name: "uppercase-digest", upperDigest: true},
  {name: "string-entry-size", stringSize: true},
  {name: "wrong-entry-size", wrongSize: true},
  {name: "duplicate-path-last-good", duplicate: "good"},
  {name: "duplicate-path-last-bad", duplicate: "bad"},
  {name: "nonpath-entries-counted-but-ignored", ignored: true},
  {name: "parent-traversal", traversal: true, rustReason: "unsafe-path"},
  {name: "nonportable-colon", colon: true, rustReason: "unsafe-path"},
];
async function record() {
  const cases = [];
  for (const definition of definitions) {
    const work = mkdtempSync(path.join(tmpdir(), "rx4-snapshot-verify-"));
    const dir = path.join(work, "snapshot"); mkdirSync(dir);
    try {
      const manifest = {...standard(), ...definition.metadata};
      const payloads = {};
      if (!definition.empty && !definition.missingPayload && !definition.traversal) payloads[definition.colon ? "store/a:b" : "store/data.bin"] = definition.changed ? payload + " changed" : payload;
      if (definition.empty) {manifest.files = []; manifest.bytes = 0; manifest.fileCount = 0;}
      if (definition.extraPayload) payloads["store/unlisted"] = "extra";
      if (definition.upperDigest) manifest.files[0].sha256 = manifest.files[0].sha256.toUpperCase();
      if (definition.stringSize) manifest.files[0].bytes = String(manifest.files[0].bytes);
      if (definition.wrongSize) manifest.files[0].bytes += 1;
      if (definition.duplicate) {
        const bad = {...entry(), sha256: "0".repeat(64)};
        manifest.files = definition.duplicate === "good" ? [bad, entry()] : [entry(), bad];
      }
      if (definition.ignored) manifest.files.push(null, {}, {path: 3}, "ignored");
      if (definition.traversal) {manifest.files = [entry("../outside")]; writeFileSync(path.join(work, "outside"), payload);}
      if (definition.colon) manifest.files = [entry("store/a:b")];
      let raw = definition.raw ?? JSON.stringify(manifest);
      if (definition.duplicateSchema) raw = '{"schema":"old",' + raw.slice(1);
      if (!definition.missingManifest) writeFileSync(path.join(dir, "snapshot.json"), raw);
      for (const [rel, bytes] of Object.entries(payloads)) {const file = path.join(dir, rel); mkdirSync(path.dirname(file), {recursive:true}); writeFileSync(file, bytes);}
      let result;
      try {result = {value: await verifySnapshot({dir})};} catch (e) {assert.equal(typeof e.reason, "string"); result = {error: e.reason};}
      cases.push({...definition, rawManifest: definition.missingManifest ? null : raw, payloads, result});
    } finally {rmSync(work, {recursive:true, force:true});}
  }
  return cases;
}
const cases = await record(); assert.deepEqual(await record(), cases);
writeFileSync(new URL("./golden/snapshot-verify.json", import.meta.url), `${JSON.stringify({recordedFrom: {engine:"node", source, node:process.version}, cases}, null, 2)}\n`);
console.log(`Recorded ${cases.length} actual Node snapshot verification cases twice; unsafe-path exceptions retain original Node results`);
