import crypto, { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { flatTargetProvider } from "../../../packages/core/test/helpers/flat-embedder.ts";
import { offlineHost, repo, runSteps, withHome } from "./side.ts";
import { PIN, type Scenario } from "./scenario.ts";

const dependency = "@cyb3rb1ade/plur1bus-memory";

async function nodeInternals(embedder: Scenario["seams"]["embedder"]): Promise<Record<string, unknown>> {
  const flat = (dimensions: number) => flatTargetProvider({ fingerprint: { dimensions } });
  const internals = { reranker: null, reembeddingTargetProvider: flatTargetProvider };
  if (embedder === "flat") return { ...internals, embeddings: flat };
  if (embedder !== "hash") throw new Error("real models require the separate real-model acceptance lane");
  const source = new URL("../../../crates/plur1bus-engine/tests/fixtures/recall/record-stages.mjs", import.meta.url);
  const { hashUnit } = await import(source.href) as { hashUnit(text: string): number[] };
  const one = async (text: string) => hashUnit(text);
  return { ...internals, embeddings: (width: number) => {
    if (width !== 384) throw new Error("the RE-04 hash embedder requires 384 dimensions");
    return {
      embed: one, embedQuery: one, embedPassage: one,
      embedBatch: async (texts: string[]) => texts.map(hashUnit), shutdown: async () => {},
    };
  } };
}

function verifyNodeInstall(): void {
  const manifest = join(repo, "packages/core/package.json");
  const specification = JSON.parse(readFileSync(manifest, "utf8")).dependencies[dependency] as string | undefined;
  if (!specification?.startsWith("git+") || !specification.endsWith(`#${PIN}`)) {
    throw new Error("the Node dependency is not at the recorded pin");
  }
  let installed: string;
  try { installed = realpathSync(createRequire(manifest).resolve(`${dependency}/package.json`)); }
  catch { throw new Error("pinned Node engine is unavailable. Run pnpm install --frozen-lockfile"); }
  const modules = join(repo, "node_modules");
  if (!relative(realpathSync(modules), installed).startsWith(`.pnpm${sep}`)) {
    throw new Error("Node engine must come from the frozen workspace install. Run pnpm install --frozen-lockfile");
  }
  const lock = (file: string) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  if (lock(join(modules, ".pnpm/lock.yaml")) !== lock(join(repo, "pnpm-lock.yaml"))) {
    throw new Error("workspace install differs from the pinned lockfile. Run pnpm install --frozen-lockfile");
  }
  const sources = JSON.parse(readFileSync(join(repo, "crates/plur1bus-engine/tests/fixtures/recall/namespace-sources.json"), "utf8")).runtime as {
    commit: string; sha256: Record<string, string>;
  };
  if (sources.commit !== PIN) throw new Error("source manifest is not at the recorded pin");
  for (const [file, expected] of Object.entries(sources.sha256)) {
    const actual = createHash("sha256").update(readFileSync(join(dirname(installed), file))).digest("hex");
    if (actual !== expected) throw new Error(`installed Node source does not match the pin: ${file}`);
  }
}

export async function runNode(scenario: Scenario) {
  verifyNodeInstall();
  return withHome(scenario, "node", async home => {
    const [{ bindEngine }, { buildEngineConfig }, { createPlatformCapabilities }] = await Promise.all([
      import("../../../packages/core/src/engine.ts"),
      import("../../../packages/core/src/engine-config.ts"),
      import("../../../packages/core/src/platform.ts"),
    ]);
    const { paths } = home;
    const config = buildEngineConfig(home.config, paths);
    const internals = await nodeInternals(scenario.seams.embedder);
    const offline = offlineHost(scenario, home);
    const clock = () => scenario.seams.clock;
    const fetchBefore = globalThis.fetch;
    const DateBefore = globalThis.Date;
    const uuidBefore = crypto.randomUUID;
    const noNetwork = async (): Promise<never> => { throw offline.denyNetwork(); };
    const logger = {
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    };
    // The pin also uses new Date() for prompt text and UUIDs for write receipts.
    // No scenarios or adapters run concurrently in this process.
    globalThis.fetch = noNetwork;
    globalThis.Date = new Proxy(DateBefore, {
      get: (target, key, receiver) => key === "now" ? clock : Reflect.get(target, key, receiver),
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [clock()], newTarget),
      apply: () => new DateBefore(clock()).toString(),
    });
    let sequence = 0;
    crypto.randomUUID = () => `e1000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    syncBuiltinESMExports();
    try {
      const engine = bindEngine({
        logger, stateDir: paths.state, configPath: () => paths.configPath,
        workspaceDir: offline.workspaceDir, config: () => config, runtime: null,
        fetch: noNetwork, ...(offline.llm ? { llm: offline.llm } : {}), clock, platform: createPlatformCapabilities(),
        events: { emit: offline.event },
      }, config, internals);
      try { return await runSteps(engine, scenario, offline.check); }
      finally {
        await engine.close({ budgetMs: 5_000 });
        offline.check();
      }
    } finally {
      globalThis.Date = DateBefore;
      crypto.randomUUID = uuidBefore;
      syncBuiltinESMExports();
      globalThis.fetch = fetchBefore;
    }
  });
}
