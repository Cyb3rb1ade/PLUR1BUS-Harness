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

// A core.shutdown RPC takes the same stop-and-exit path as SIGTERM (I1): without it the process outlived the stop.
const core = createCore({ ...(values.home ? { home: values.home } : {}), ...(testInternals ? { testInternals } : {}), onShutdownRequested: (budgetMs) => stop("core.shutdown", budgetMs) });

// Reused across repeated signals: core.ts's own resolved config isn't exposed on the committed Core surface
// (start/stop/status/address/token/layout), so this reads config.json once after a successful start rather
// than editing core.ts to expose it; on any failure to read it back, stop() falls back to its own default.
let shutdownBudgetMs: number | undefined;
let stopping = false;
/** The one stop path for SIGTERM, SIGINT and a `core.shutdown` RPC: stop the core (engine, server, lock, run
 *  files, log flush), then exit 0, or 1 when a stop step failed. An RPC's own budgetMs wins over config's. */
const stop = (why: string, budgetMs?: number) => {
  if (stopping) { console.error(`core: ${why} ignored, stop already in progress`); return; } // core.stop() is idempotent, but a repeated request is still just noise here
  stopping = true;
  console.error(`core: ${why}, stopping`);
  const budget = budgetMs ?? shutdownBudgetMs;
  core.stop(budget !== undefined ? { budgetMs: budget } : {})
    .then(() => process.exit(core.status().process.reason === "stop-step-failed" ? 1 : 0))
    .catch((err) => { console.error("core: stop failed", err); process.exit(1); });
};
process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
try {
  await core.start();
  try { shutdownBudgetMs = loadConfig(core.layout.configPath).config.core.shutdownBudgetMs; } catch { /* best effort: fall back to the core's own default */ }
  console.log(JSON.stringify({ ready: true, address: core.address, pid: process.pid }));
} catch (e) {
  if (e instanceof RpcError && e.error === "E_LOCKED") { console.error(`core: ${e.message} (${e.detail ?? ""})`); process.exit(3); }
  if (e instanceof RpcError && e.error === "E_RPC_VERSION") { console.error(`core: ${e.message}`); process.exit(4); }
  if (e instanceof ConfigInvalid) { console.error(`core: config invalid: ${e.errors.join("; ")}`); process.exit(2); }
  console.error("core: start failed", e); process.exit(1);
}
