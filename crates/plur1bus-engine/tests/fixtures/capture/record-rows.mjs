// Records actual pinned Node capture rows and chunk plans; never edit its output.
// PLUR1BUS_ENGINE_SRC=/path/to/pin PLUR1BUS_ENGINE_GIT=/read-only/git node record-rows.mjs
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const [{ createEngine }, { internalsOf }, { createStubHost }, { hashEmbedder }, { flatEmbedder }, chunking, scoreApi, deciderApi] = await Promise.all([
  load("engine/create-engine.js"), load("engine/internals.js"), load("lib/host-services.js"),
  load("tests/helpers/hash-embedder.js"), load("tests/helpers/shared-workspace-engine.js"),
  load("lib/memory-chunking.js"), load("lib/score.js"), load("lib/jev-chunk-decider.js"),
]);
const scenarios = JSON.parse(readFileSync(join(here, "scenarios/rows.json"), "utf8"));
const fixedNow = 1_710_000_000_000;
const realNow = Date.now;
const realFetch = globalThis.fetch;
Date.now = () => fixedNow;
globalThis.fetch = async () => { throw new Error("recorder refuses unrecorded network access"); };
const recordings = [];
const llmFixtures = {};
let schemaSeedLine;
try {
  for (const scenario of scenarios) {
    const scopedFixtures = llmFixtures[scenario.name] = {};
    const root = mkdtempSync(join(tmpdir(), "capture-rows-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const warnings = [];
    const logger = { info() {}, debug() {}, error() {}, warn: (message) => warnings.push(String(message)) };
    const requests = [];
    const secretName = "PLUR1BUS_CAPTURE_RECORDER_DECIDER";
    const previousSecret = process.env[secretName];
    if (scenario.choice) process.env[secretName] = randomUUID();
    let engine;
    try {
      const llm = scenario.llm ? {
        async complete(params) {
          const messagesJson = JSON.stringify(params.messages);
          const promptHash = sha(messagesJson);
          const { purpose, signal, ...contractParams } = params;
          const fixture = { messagesJson, paramsJson: JSON.stringify(params), contractParamsJson: JSON.stringify(contractParams),
            boundary: { purpose: purpose ?? null, signal: signal instanceof AbortSignal ? "Cancel" : null } };
          requests.push(promptHash);
          if (scenario.summaryFailure && purpose === "capture-summary") {
            scopedFixtures[promptHash] = { ...fixture, error: "unavailable" };
            throw new Error("summary fixture unavailable");
          }
          const answer = { text: purpose === "capture-summary" ? scenario.summary ?? "[]" : "[]", provider: "fixture", model: "fixture", usage: {} };
          scopedFixtures[promptHash] = { ...fixture, resultJson: JSON.stringify(answer) };
          return answer;
        },
      } : undefined;
      const host = createStubHost({
        stateDir: join(root, "state"), logger, clock: () => fixedNow,
        workspaceDir: async () => workspace,
        capabilities: { postTurnRefineScheduled: scenario.scheduled === true },
        llm, runtime: llm ? { llm } : null,
        fetch: async (_url, options) => {
          const request = JSON.parse(options.body);
          const requestJson = JSON.stringify(request);
          const requestHash = sha(requestJson);
          const response = { answers: { structure: { choice: scenario.choice, confidence: 1 } } };
          requests.push(requestHash);
          scopedFixtures[requestHash] = { transport: "chunk-decider", requestJson, resultJson: JSON.stringify(response) };
          return Response.json(response);
        },
      });
      const config = {
        baseDbPath: join(root, "stores"),
        embedding: { provider: "local-transformers", local: { dimensions: 384 } },
        autoCapture: true,
        autoRecall: false,
        ...scenario.config,
        ...(scenario.choice ? { captureChunkingJev: { apiKeyEnv: secretName } } : {}),
      };
      engine = createEngine(host, config, { internals: {
        embeddings: scenario.embedder === "flat" ? flatEmbedder() : hashEmbedder(), reranker: null,
      } });
      const internals = internalsOf(engine);
      if (scenario.workspaceEnabled === false) {
        await internals.workspacePolicyStore.set({
          agentId: "capture-agent", workspaceIdentity: `workspace-dir:v1:${workspace}`,
          enabled: false, actorId: "capture-recorder", expectedRevision: 0,
        });
      }
      const outcomes = [];
      for (const [index, messages] of scenario.turns.entries()) {
        outcomes.push(await engine.capture({
          agentId: "capture-agent",
          principal: { agentId: "capture-agent", workspace: `workspace-dir:v1:${workspace}`, channel: "telegram", accountId: "default",
            chat: { id: "capture-chat", kind: "direct" }, trust: "proved" },
          agent: { origin: "user", background: false },
          messages, runId: `capture-${index}`, sessionKey: "capture-session", incognito: false,
          signal: AbortSignal.timeout(10_000),
        }, scenario.options).done);
        if (scenario.patchFirstRowAfterTurn === index) {
          await internals.pool.withDb("capture-agent", async (db) => {
            const rows = await db.table.query().toArray();
            if (rows.length === 0) throw new Error("patch scenario did not produce its initial row");
            await db.update(rows[0].id, scenario.patch);
          });
        }
      }
      const rows = await internals.pool.withDb("capture-agent", async (db) => {
        await db.init();
        const schema = await db.table.schema();
        const project = (row) => {
          const result = {};
          for (const field of schema.fields) {
            result[field.name] = field.name === "vector" ? Array.from(row[field.name]) : row[field.name];
          }
          return result;
        };
        if (schemaSeedLine === undefined) {
          try {
            await db.table.checkout(1);
            const seedRows = await db.table.query().toArray();
            const seed = seedRows.find((row) => row.id === "__schema__");
            if (!seed) throw new Error("pinned schema seed row is missing from the creation version");
            schemaSeedLine = JSON.stringify(project(seed));
          } finally {
            await db.table.checkoutLatest();
          }
        }
        const values = await db.table.query().toArray();
        return values.filter((row) => row.id !== "__schema__").map(project);
      });
      const ids = new Map();
      const canonical = (key, value) => {
        if (key === "id" || key === "chunkGroupId" && value) {
          if (!ids.has(value)) ids.set(value, `volatile-id-${ids.size + 1}`);
          return ids.get(value);
        }
        return typeof value === "string" ? value.replaceAll(root, "<scratch>") : value;
      };
      recordings.push({ name: scenario.name, config: scenario.config, options: scenario.options ?? {},
        outcomesJson: JSON.stringify(outcomes), rowLines: rows.map((row) => JSON.stringify(row, canonical)),
        warningCount: warnings.length, requestHashes: requests });
    } finally {
      await engine?.close({ budgetMs: 5_000 });
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
      rmSync(root, { recursive: true, force: true });
    }
  }
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}

const planInputs = [
  ...scenarios.flatMap((scenario) => scenario.turns.flat().map((message) => ({ name: scenario.name, text: message.content }))),
  ...JSON.parse(readFileSync(join(here, "scenarios/chunking.json"), "utf8")),
  { name: "part-cap-bundles-without-truncation", text: Array.from({ length: 41 }, (_entry, index) => `- Item ${index} is an independent important fact.`).join("\n") },
];
const plans = planInputs.map(({ name, text }) => ({
  name, textUnits: Array.from({ length: text.length }, (_value, index) => text.charCodeAt(index)),
  json: JSON.stringify(chunking.planChunks(text)),
}));
const expansions = [];
for (const { name, text } of planInputs) {
  for (const mode of ["disabled", "both", "parts", "decided-whole", "decided-parts", "decided-both"]) {
    const preps = [{ it: { ordinal: 0 }, text, ok: true }];
    let groupCount = 0;
    const makeGroupId = () => `capture-group-${++groupCount}`;
    const result = mode.startsWith("decided-")
      ? await chunking.expandForCaptureDecided(preps, {
        makeGroupId, decide: async () => ({ storage: mode.slice("decided-".length) }),
      })
      : chunking.expandForCapture(preps, { enabled: mode !== "disabled", keepWhole: mode !== "parts", makeGroupId });
    expansions.push({ name, mode, textUnits: Array.from({ length: text.length }, (_value, index) => text.charCodeAt(index)),
      json: JSON.stringify(result) });
  }
}
const scoreCases = [0, 0.01, 0.1, 1, 2, 4].flatMap((distance) => {
  const nativeDistance = Math.fround(distance);
  const score = scoreApi.distanceToScore(nativeDistance);
  return [score, score + Number.EPSILON, 1.01].map((threshold) => ({
    distance: nativeDistance, threshold, scoreJson: JSON.stringify(score), duplicate: score >= threshold,
  }));
});
const deciderCases = [
  { choice: "coherent", confidence: 1 }, { choice: "independent", confidence: 1 },
  { choice: "mixed", confidence: 1 }, { choice: "coherent", confidence: 0.84 },
  { choice: "coherent", confidence: 0.85 }, { choice: "independent", confidence: "0.9" },
  { choice: "unknown", confidence: 1 }, null,
].map((answer) => ({ answer, storage: deciderApi.storageForJevAnswer(answer) }));
const metadata = { engine: "node", commit: pin, node: process.version, fixedNow, sourceHashes: hashes,
  sourcePathJoiner: ["open", "claw"],
  volatileFields: { id: "first-occurrence label", chunkGroupId: "first-occurrence label", root: "<scratch>" },
  options: "Every per-scenario option is recorded; no source behavior is monkey-patched.",
  fixturePorts: { embedder: "pinned deterministic hash helper; no model access", reranker: "null; capture does not call reranking" },
  llmBoundary: { promptHash: "SHA-256 of exact Node JSON.stringify(messages)",
    purpose: "fixed internal adapter stage; no corresponding field in frozen Rust LlmParams",
    signal: "forwarded as the existing Cancel argument", requestParity: "messages plus contract-expressible params only" },
};
mkdirSync(join(here, "golden"), { recursive: true });
mkdirSync(join(here, "llm"), { recursive: true });
for (const [name, data] of [["golden/rows.json", { metadata, recordings }], ["golden/chunk-plans.json", { metadata, plans }],
  ["golden/dedupe.json", { metadata, cases: scoreCases }], ["golden/chunk-decider.json", { metadata, cases: deciderCases }],
  ["golden/schema-seed.json", { metadata, rowLine: schemaSeedLine }],
  ["golden/chunk-expansions.json", { metadata, cases: expansions }],
  ["llm/rows.json", { scopes: llmFixtures }]]) {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  if (json.toLowerCase().includes(legacyMarker)) throw new Error("recorder output violates repository naming policy");
  writeFileSync(join(here, name), json);
}
console.log(`recorded ${recordings.length} actual engine capture scenarios and ${plans.length} chunk plans`);
