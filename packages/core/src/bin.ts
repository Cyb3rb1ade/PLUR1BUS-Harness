import { parseArgs } from "node:util";
import { ConfigInvalid, loadConfig } from "./config-load.ts";
import { createCore } from "./core.ts";
import { RpcError } from "./rpc/errors.ts";

const { values } = parseArgs({ options: { home: { type: "string" }, "test-internals": { type: "string" } }, strict: true });
let testInternals: Record<string, unknown> | undefined;
if (values["test-internals"]) {
  if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") { console.error("--test-internals requires PLUR1BUS_ALLOW_TEST_INTERNALS=1"); process.exit(2); }
  if (values["test-internals"] === "flat-embedder") {
    const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)); const one = async () => vector();
    // R17: force the null reranker alongside the flat embedder — production config always turns the reranker
    // on (engine-config.ts), so with >= 2 memories the engine would otherwise download the ONNX model in tests.
    testInternals = { embeddings: { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (t: string[]) => t.map(vector), shutdown: async () => {} }, reranker: null };
  } else { console.error(`unknown --test-internals ${values["test-internals"]}`); process.exit(2); }
}

const core = createCore({ ...(values.home ? { home: values.home } : {}), ...(testInternals ? { testInternals } : {}) });
const stop = (sig: string) => {
  console.error(`core: ${sig}, stopping`);
  let budgetMs: number | undefined;
  try { budgetMs = loadConfig(core.layout.configPath).config.core.shutdownBudgetMs; } catch { /* best effort: fall back to the core's own default */ }
  void core.stop(budgetMs !== undefined ? { budgetMs } : {}).then(() => process.exit(0));
};
process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
try {
  await core.start();
  console.log(JSON.stringify({ ready: true, address: core.address, pid: process.pid }));
} catch (e) {
  if (e instanceof RpcError && e.error === "E_LOCKED") { console.error(`core: ${e.message} (${e.detail ?? ""})`); process.exit(3); }
  if (e instanceof ConfigInvalid) { console.error(`core: config invalid: ${e.errors.join("; ")}`); process.exit(2); }
  console.error("core: start failed", e); process.exit(1);
}
