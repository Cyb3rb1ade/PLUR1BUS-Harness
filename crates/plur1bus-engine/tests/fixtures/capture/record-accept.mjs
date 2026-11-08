/** Records public Engine.capture admission/results from verified Node sources (RE-05/T1). */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const gitRoot = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !gitRoot || process.version !== "v24.21.0") {
  throw new Error("Node 24.21.0, PLUR1BUS_ENGINE_SRC and read-only PLUR1BUS_ENGINE_GIT are required");
}
const here = dirname(fileURLToPath(import.meta.url));
const git = (...args) => execFileSync("git", ["-C", gitRoot, ...args], { maxBuffer: 16 * 1024 * 1024 });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const marker = ["open", "claw"].join("");
const files = git("ls-tree", "-r", "--name-only", pin, "engine", "lib", "package.json", `${marker}.plugin.json`)
  .toString().trim().split("\n").filter((name) => /\.(js|json)$/.test(name));
files.push("tests/helpers/hash-embedder.js");
const hashes = [];
for (const name of files) {
  const expected = sha(git("show", `${pin}:${name}`));
  if (sha(readFileSync(join(source, name))) !== expected) throw new Error("pinned source hash mismatch");
  hashes.push({ pathParts: name.split(marker), sha256: expected });
}
const require = createRequire(resolve(here, "../../../../../packages/core/package.json"));
const installed = createRequire(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const dependencies = new Map(["@lancedb/lancedb", "apache-arrow", "openai", "@huggingface/transformers"]
  .map((name) => [name, pathToFileURL(installed.resolve(name)).href]));
registerHooks({ resolve(specifier, context, next) {
  return dependencies.has(specifier) ? { shortCircuit: true, url: dependencies.get(specifier) } : next(specifier, context);
} });
const load = (name) => import(pathToFileURL(join(source, name)));
const [{ createEngine }, { createStubHost }, { hashEmbedder }] = await Promise.all([
  load("engine/create-engine.js"), load("lib/host-services.js"), load("tests/helpers/hash-embedder.js"),
]);
const cases = [
  { name: "incognito", patch: { incognito: true } },
  { name: "principal-mismatch", patch: { principal: { agentId: "other" } } },
  { name: "internal", patch: { agent: { origin: "cron", background: true } } },
  { name: "aborted", abort: true },
  { name: "completed", repeat: true },
  { name: "no-session", omitSession: true },
  { name: "defer-unscheduled", options: { deferPostTurnLlm: true } },
];
const fixedNow = 1_710_000_000_000;
const dateNow = Date.now;
const fetch = globalThis.fetch;
const results = [];
Date.now = () => fixedNow;
globalThis.fetch = async () => { throw new Error("recorder refuses unrecorded network access"); };
try {
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), "capture-accept-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    let workspaceCalls = 0;
    const host = createStubHost({
      stateDir: join(root, "state"), clock: () => fixedNow,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      workspaceDir: async () => { workspaceCalls++; return workspace; },
    });
    const config = { baseDbPath: join(root, "stores"), autoCapture: true,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } } };
    const engine = createEngine(host, config, { internals: { embeddings: hashEmbedder(), reranker: null } });
    try {
      const abort = new AbortController();
      if (scenario.abort) abort.abort();
      const turn = { agentId: "capture-agent",
        principal: { agentId: "capture-agent", channel: "telegram", accountId: "default",
          chat: { id: "capture-chat", kind: "direct" }, trust: "proved" },
        agent: { origin: "user", background: false }, messages: [{ role: "user",
          content: "The release planning meeting takes place every Thursday morning." }],
        runId: scenario.name, sessionKey: "capture-session", incognito: false, signal: abort.signal,
        ...scenario.patch };
      if (scenario.omitSession) delete turn.sessionKey;
      const receipt = engine.capture(turn, scenario.options);
      const lines = [JSON.stringify(await receipt.done)];
      if (scenario.repeat) lines.push(JSON.stringify(await engine.capture(turn).done));
      const guard = join(root, "stores", "_capture-turns", "capture-agent.json");
      const guardExists = (() => { try { readFileSync(guard); return true; } catch { return false; } })();
      const journalCount = (directory) => {
        try {
          return readdirSync(directory, { withFileTypes: true }).reduce((count, item) => {
            const path = join(directory, item.name);
            if (item.isDirectory()) return count + journalCount(path);
            return count + (item.name === "turn-journal.jsonl" ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0);
          }, 0);
        } catch { return 0; }
      };
      results.push({ name: scenario.name, resultLines: lines, acceptedAt: receipt.acceptedAt,
        validReceiptId: /^[a-f0-9-]{36}$/.test(receipt.id), guardExists, workspaceCalls,
        journalLines: journalCount(root), config });
    } finally {
      await engine.close({ budgetMs: 5_000 });
      rmSync(root, { recursive: true, force: true });
    }
  }
} finally {
  Date.now = dateNow;
  globalThis.fetch = fetch;
}
for (const result of results) result.config.baseDbPath = "<scratch>/stores";
mkdirSync(join(here, "golden"), { recursive: true });
writeFileSync(join(here, "golden", "accept.json"), `${JSON.stringify({ provenance: {
  engine: "node", commit: pin, node: process.version, flags: ["--accept"], fixedNow,
  sourceHashes: hashes, sourcePathJoiner: ["open", "claw"],
  disabledOptions: [], fixturePorts: "pinned hash embedder, null reranker; absent LLM; network refused",
}, cases: results }, null, 2)}\n`);
