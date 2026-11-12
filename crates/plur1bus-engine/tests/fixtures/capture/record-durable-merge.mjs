// Records actual pinned Node durable-merge helpers and execution; never edit its output.
// PLUR1BUS_ENGINE_SRC=/path/to/pin PLUR1BUS_ENGINE_GIT=/read-only/git node record-durable-merge.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const sourceGit = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !sourceGit) throw new Error("pinned source and read-only Git source are required");
if (process.version !== "v24.21.0") throw new Error("capture recorder requires Node 24.21.0");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", sourceGit, ...args], { maxBuffer: 16 * 1024 * 1024 });
const legacyMarker = ["open", "claw"].join("");
const paths = git("ls-tree", "-r", "--name-only", pin, "engine", "lib", "tests/helpers", "package.json", `${legacyMarker}.plugin.json`)
  .toString().trim().split("\n").filter((name) => /\.(?:js|json)$/.test(name));
const hashes = [];
for (const name of paths) {
  const expected = sha(git("show", `${pin}:${name}`));
  const actual = sha(readFileSync(join(source, name)));
  if (actual !== expected) throw new Error("pinned source hash mismatch");
  hashes.push({ pathParts: name.split(legacyMarker), sha256: actual });
}

// Dependencies resolve from this prepared Harness checkout; Node source still comes from the verified pin.
const require = createRequire(resolve(here, "../../../../../packages/core/package.json"));
const engineRequire = createRequire(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const dependencies = new Map(["@lancedb/lancedb", "apache-arrow", "openai", "@huggingface/transformers"]
  .map((name) => [name, pathToFileURL(engineRequire.resolve(name)).href]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    return dependencies.has(specifier)
      ? { url: dependencies.get(specifier), shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const load = (name) => import(pathToFileURL(join(source, name)).href);
// Verify the test helper before importing it, as for every engine source above.
const helper = "tests/helpers/hash-embedder.js";
const helperExpected = sha(git("show", `${pin}:${helper}`));
if (sha(readFileSync(join(source, helper))) !== helperExpected) throw new Error("pinned helper hash mismatch");
hashes.push({ pathParts: [helper], sha256: helperExpected });
const [{ createEngine }, { internalsOf }, { createStubHost }, { hashEmbedder }] = await Promise.all([
  load("engine/create-engine.js"), load("engine/internals.js"), load("lib/host-services.js"),
  load("tests/helpers/hash-embedder.js"),
]);
const assert = (await import("node:assert/strict")).default;
const NOW = 1735689600000;
const OWNER = `user:v1:${sha("synthetic merge owner")}`;
const ID = "11111111-1111-4111-8111-111111111111";
const RealDate = Date, realFetch = globalThis.fetch;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async () => { throw new Error("unrecorded network refused"); };
const clone = value => JSON.parse(JSON.stringify(value));
async function record() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "durable-merge-oracle-")));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const archive = join(root, `.${legacyMarker}`, "memory", "_archive", "alpha");
  const host = createStubHost({ stateDir: join(root, "state"), workspaceDir: async () => workspace,
    pathOverrides: { [`${legacyMarker}Home`]: () => root,
      stateDirOverride: () => join(root, "state"), configPathOverride: () => join(root, "state/config.json") },
    clock: () => NOW, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  let engine;
  try {
    engine = createEngine(host, { baseDbPath: join(root, "stores"),
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: false, autoRecall: false, neo: { enabled: false }, merging: { enabled: false },
      gc: { enabled: false }, obsidianBridge: { enabled: false }, metaCognition: { enabled: false },
      runtime: { llmResultCacheEnabled: false, llmResultCachePersist: false } },
    { internals: { embeddings: hashEmbedder(), reranker: null } });
    const internal = internalsOf(engine);
    const { resolveDefaultArchiveDir } = await load("lib/telegram-commands/memory-edit.js");
    assert.equal(resolveDefaultArchiveDir(), join(root, `.${legacyMarker}`, "memory", "_archive"));
    const base = { workspaceKey: "workspace:v1:fixture", text: "Synthetic incoming claim", category: "fact",
      origin: "dm", importance: 0.7, ttl: "", sourceUrl: "", evidenceQuote: "fixture evidence",
      scope: "agent-private", ownerUserId: OWNER, validFrom: 0, validUntil: 0 };
    const times = [null, false, true, 0, -1, 1.5, 17, "17", " 17 ", "invalid", "", [], [17], [1, 2], {}, 9007199254740991, 9007199254740992];
    const inputs = [{}, base, { ...base, text: "Astral 😀 and lone " + String.fromCharCode(0xd83d) },
      ...times.map(validFrom => ({ ...base, validFrom, validUntil: "99" }))];
    const keys = inputs.map(input => ({ input, value: internal.durableMergeWriteKey(input) }));
    const lineages = times.map(validFrom => { const candidate = { id: ID, validFrom, validUntil: 99 };
      return { candidate, value: internal.durableMergeLineage(candidate) }; });
    const metadata = [undefined, null, "", "observed", "inferred", "untrusted", "trusted", "corroborated", "disputed", "invalidated", " Trusted ", 17, {}]
      .map(epistemicStatus => { const candidate = { id: ID, epistemicStatus };
        return { candidate, value: internal.durableMergeEpistemicMetadata(candidate) }; });
    const original = { id: ID, text: "Synthetic existing claim", agentId: "alpha", storedBy: "alpha",
      workspaceId: "workspace:v1:fixture", workspaceKey: "workspace:v1:fixture", scope: "agent-private", ownerUserId: OWNER,
      sourceUrl: "", evidenceQuote: "fixture evidence", status: "active", vector: [1, 0, 0, 0], importance: 0.5,
      category: "fact", validFrom: 17, validUntil: 99, epistemicStatus: "trusted", previousEpistemicStatus: "observed",
      epistemicStatusActor: "fixture", epistemicStatusReason: "fixture provenance", epistemicStatusUpdatedAt: NOW - 1 };
    const { checkAccess } = await load("lib/acl-middleware.js");
    assert.deepEqual(checkAccess({ agentId: "alpha", workspaceAliases: { paths: [], aliases: [] } }, original), { allowed: true });
    const identities = [];
    for (const writeKey of [...keys.map(entry => entry.value), "", "synthetic alternative"]) {
      let replacementId = null;
      const result = await internal.withDurableMerge({
        db: { getById: async () => clone(original) }, agentId: "alpha",
        selectedCandidate: { entry: clone(original), score: 0.8 },
        accessCtx: { agentId: "alpha", workspaceAliases: { paths: [], aliases: [] } },
        workspaceDir: workspace, writeKey,
        prepareReplacement: async (_candidate, id) => { replacementId = id; return null; },
      });
      assert.equal(result, null); assert(replacementId);
      identities.push({ agentId: "alpha", candidateId: ID,
        effectiveWriteKey: writeKey || original.text, replacementId });
    }
    const cases = [];
    for (const mode of ["success", "prepare-refused", "stale-before", "inactive", "stale-during-prepare", "stale-before-delete",
      "write-fails", "verification-read-fails", "wrong-text", "wrong-owner", "delete-fails", "existing-exact", "existing-collision"]) {
      rmSync(join(workspace, ".adaptive-learning"), { recursive: true, force: true });
      rmSync(archive, { recursive: true, force: true });
      const rows = new Map([[ID, clone(original)]]), calls = [];
      if (mode === "stale-before") rows.get(ID).text = "Changed before preparation";
      if (mode === "inactive") rows.get(ID).status = "superseded";
      let sourceReads = 0, replacementReads = 0, plannedId = null, prepared = null;
      const archived = () => existsSync(archive) && readdirSync(archive).length === 1;
      const db = {
        async getById(id) {
          calls.push(["get", id]);
          if (id === ID) {
            sourceReads++;
            if (mode === "stale-before-delete" && sourceReads === 3) rows.get(ID).text = "Changed before deletion";
          } else {
            replacementReads++;
            if (mode === "verification-read-fails" && replacementReads === 2) throw new Error("fixture verification read failed");
          }
          return rows.has(id) ? clone(rows.get(id)) : null;
        },
        async store(row) {
          calls.push(["store", row.id, { archived: archived() }]);
          if (mode === "write-fails") throw new Error("fixture store failed");
          const actual = clone(row);
          if (mode === "wrong-text") actual.text = "Changed replacement";
          if (mode === "wrong-owner") actual.ownerUserId = "another-owner";
          rows.set(row.id, actual);
        },
        async delete(id) {
          calls.push(["delete", id, { archived: archived() }]);
          if (mode === "delete-fails") throw new Error("fixture delete failed");
          rows.delete(id);
        },
      };
      const writeKey = internal.durableMergeWriteKey(base);
      let result;
      try {
        const actual = await internal.withDurableMerge({ db, agentId: "alpha", selectedCandidate: { entry: clone(original), score: 0.8 },
          accessCtx: { agentId: "alpha", workspaceAliases: { paths: [], aliases: [] } }, workspaceDir: workspace, writeKey,
          prepareReplacement: async (candidate, replacementId) => {
            plannedId = replacementId; calls.push(["prepare", replacementId]);
            if (mode === "prepare-refused") return null;
            if (mode === "stale-during-prepare") rows.get(ID).text = "Changed during preparation";
            prepared = { mergedEntry: { ...candidate, id: replacementId, text: "Synthetic combined claim",
              mergedFrom: JSON.stringify(internal.durableMergeLineage(candidate)), ...internal.durableMergeEpistemicMetadata(candidate) },
              mergeResult: { merge: true, mergedText: "Synthetic combined claim", reason: "fixture" }, mergedImportance: 0.7 };
            if (mode === "existing-exact" || mode === "existing-collision") {
              rows.set(replacementId, clone(prepared.mergedEntry));
              if (mode === "existing-collision") rows.get(replacementId).text = "Different existing replacement";
            }
            return prepared;
          } });
        result = actual ? { idempotencyKey: actual.idempotencyKey, replacementId: actual.mergedEntry.id } : null;
      } catch (error) { result = { error: String(error.message).replaceAll(root, "<root>") }; }
      const files = archived() ? readdirSync(archive).map(name => ({ name, value: JSON.parse(readFileSync(join(archive, name), "utf8")) })) : [];
      const auditPath = join(workspace, ".adaptive-learning/destructive-ops.jsonl");
      const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8").trim().split("\n").map(line => {
        const entry = JSON.parse(line); entry.archivePath = entry.archivePath.replaceAll(join(root, `.${legacyMarker}`), "<archive-root>"); return entry;
      }) : [];
      if (mode === "success" || mode === "existing-exact") {
        assert(result?.idempotencyKey && result?.replacementId, `expected actual merge success: ${mode}: ${JSON.stringify(result)}`);
        assert(calls.some(call => call[0] === "delete"));
        assert.equal(files.length, 1); assert.equal(audit.length, 1);
      } else if (mode === "prepare-refused") {
        assert.equal(result, null); assert.equal(files.length, 0);
      } else { assert(result?.error, `expected actual merge refusal: ${mode}`); }
      cases.push({ name: mode, original, writeKey, plannedId, prepared, result, calls, rows: [...rows.values()], archive: files, audit });
    }
    return { keys, lineages, metadata, identities, cases };
  } finally {
    try { await engine?.close({ budgetMs: 5000 }); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}
try {
  const first = await record(); assert.deepEqual(await record(), first);
  const output = JSON.stringify({ pin, now: NOW, node: process.version,
    sourceHashes: hashes, sourcePathJoiner: ["open", "claw"],
    boundaries: { database: "offline map port; not a Lance integration recording", archive: "actual Node temporary files", model: "not invoked", volatile: "temporary archive root only" }, ...first }, null, 2) + "\n";
  if (output.toLowerCase().includes(legacyMarker)) throw new Error("invalid naming");
  writeFileSync(join(here, "golden/durable-merge.json"), output);
  console.log(`Recorded ${first.keys.length} keys, ${first.lineages.length} lineages, ${first.metadata.length} epistemic projections, ${first.identities.length} replacement identities and ${first.cases.length} actual Node durable-merge executions twice`);
} finally {
  globalThis.Date = RealDate; globalThis.fetch = realFetch;
}
