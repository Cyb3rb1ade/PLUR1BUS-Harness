import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigInvalid } from "./config-load.ts";
import { createCore } from "./core.ts";
import { RpcError } from "./rpc/errors.ts";
import { InMemoryProfileSource, StaticCredentialResolver } from "./discovery/testing.ts";
import type { ProfileInfo } from "./discovery/ports.ts";
import { FakeChatProvider } from "./session/provider.ts";

// Under a supervisor, stdout and stderr are pipes that the supervisor reads. A SIGKILLed supervisor leaves them without
// a reader while the core lives on through its lifeline grace (S5, C1), so every later write fails with EPIPE. The
// core's own log file is the record: a lost stdio sink must never crash the core (e.g. midway through the grace-expiry stop).
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

const { values } = parseArgs({ options: { home: { type: "string" }, "test-internals": { type: "string" }, lifeline: { type: "string" }, instance: { type: "string" } }, strict: true });
// Supervised mode (S4): the supervisor spawns the core with `--lifeline stdin --instance <uuid>` and holds stdin's write end.
if (values.lifeline !== undefined && values.lifeline !== "stdin") { console.error(`--lifeline accepts only stdin, got ${values.lifeline}`); process.exit(2); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (values.instance !== undefined && !UUID.test(values.instance)) { console.error(`--instance must be a UUID, got ${values.instance}`); process.exit(2); }
let testInternals: Record<string, unknown> | undefined;
if (values["test-internals"]) {
  if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") { console.error("--test-internals requires PLUR1BUS_ALLOW_TEST_INTERNALS=1"); process.exit(2); }
  const variant = values["test-internals"];
  if (variant === "flat-embedder" || variant === "flat-embedder-cold") {
    const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)); const one = async () => vector();
    // flat-embedder-cold (H3-R22): the first 2 embedQuery calls of this process (the warm-up probe and its
    // memory.list) take 350 ms each, one after the other (a cold model serves one inference at a time) — enough that a recall issued before the warm-up finished queues
    // behind the warm-up's probe and overruns the core's 600 ms hard budget.
    let coldCalls = variant === "flat-embedder-cold" ? 2 : 0; let coldChain: Promise<void> = Promise.resolve();
    const query = async () => {
      if (coldCalls > 0) { coldCalls--; const mine = coldChain.then(() => new Promise<void>((r) => setTimeout(r, 350))); coldChain = mine; await mine; }
      return vector();
    };
    // R17: force the null reranker alongside the flat embedder — production config always turns the reranker
    // on (engine-config.ts), so with >= 2 memories the engine would otherwise download the ONNX model in tests.
    testInternals = { embeddings: { embed: one, embedQuery: query, embedPassage: one, embedBatch: async (t: string[]) => t.map(vector), shutdown: async () => {} }, reranker: null };
  } else { console.error(`unknown --test-internals ${values["test-internals"]}`); process.exit(2); }
}

let discoveryOptions: { profiles: InMemoryProfileSource; credentials: StaticCredentialResolver; scheduler: boolean } | undefined;
if (process.env.PLUR1BUS_TEST_DISCOVERY_PROFILES) {
  if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") {
    console.error("PLUR1BUS_TEST_DISCOVERY_PROFILES requires PLUR1BUS_ALLOW_TEST_INTERNALS=1");
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(process.env.PLUR1BUS_TEST_DISCOVERY_PROFILES, "utf8"));
  const profiles: ProfileInfo[] = [];
  const credentials: Record<string, { origin: string; headerName: string; headerValue: string }> = {};
  for (const p of (raw.profiles as any[]) ?? []) {
    profiles.push({
      id: p.id,
      discovery: p.discovery,
      baseUrl: p.baseUrl,
      ...(p.vendor !== undefined ? { vendor: p.vendor } : {}),
    });
    if (p.credential) {
      const origin = new URL(p.baseUrl).origin;
      credentials[p.id] = {
        origin,
        headerName: p.credential.headerName,
        headerValue: p.credential.headerValue,
      };
    }
  }
  discoveryOptions = {
    profiles: new InMemoryProfileSource(profiles),
    credentials: new StaticCredentialResolver(credentials),
    scheduler: false,
  };
}

// M1b-2c test seam: the deterministic fake chat provider, until the real adapters (packages/providers) are wired in.
let chatProvider: FakeChatProvider | undefined;
if (process.env.PLUR1BUS_TEST_CHAT_PROVIDER !== undefined) {
  if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") { console.error("PLUR1BUS_TEST_CHAT_PROVIDER requires PLUR1BUS_ALLOW_TEST_INTERNALS=1"); process.exit(2); }
  if (process.env.PLUR1BUS_TEST_CHAT_PROVIDER !== "fake") { console.error(`unknown PLUR1BUS_TEST_CHAT_PROVIDER ${process.env.PLUR1BUS_TEST_CHAT_PROVIDER}`); process.exit(2); }
  chatProvider = new FakeChatProvider();
}

// A core.shutdown RPC takes the same stop-and-exit path as SIGTERM (I1): without it the process outlived the stop.
const core = createCore({
  ...(values.home ? { home: values.home } : {}), ...(testInternals ? { testInternals } : {}),
  ...(discoveryOptions ? { discovery: discoveryOptions } : {}), ...(chatProvider ? { chatProvider } : {}),
  ...(values.instance ? { instanceId: values.instance.toLowerCase() } : {}), ...(values.lifeline === "stdin" ? { lifeline: process.stdin, supervisorConfig: {} } : {}), // B7: 3 × 1 s config.watch
  onShutdownRequested: (budgetMs) => stop("core.shutdown", budgetMs),
  onOrphanGraceExpired: () => stop("lifeline grace expired"),
});

let stopping = false;
/** The one stop path for SIGTERM, SIGINT and a `core.shutdown` RPC: stop the core (engine, server, lock, run
 *  files, log flush), then exit 0, or 1 when a stop step failed. An RPC's own budgetMs wins over config's. */
const stop = (why: string, budgetMs?: number) => {
  if (stopping) { console.error(`core: ${why} ignored, stop already in progress`); return; } // core.stop() is idempotent, but a repeated request is still just noise here
  stopping = true;
  console.error(`core: ${why}, stopping`);
  // `core.shutdownBudgetMs` is live: the configuration running now (none before start: stop()'s own default).
  const budget = budgetMs ?? core.currentConfig()?.core.shutdownBudgetMs;
  core.stop(budget !== undefined ? { budgetMs: budget } : {})
    .then(() => process.exit(core.status().process.reason === "stop-step-failed" ? 1 : 0))
    .catch((err) => { console.error("core: stop failed", err); process.exit(1); });
};
process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
try {
  await core.start();
  console.log(JSON.stringify({ ready: true, address: core.address, pid: process.pid }));
} catch (e) {
  if (e instanceof RpcError && e.error === "E_LOCKED") { console.error(`core: ${e.message} (${e.detail ?? ""})`); process.exit(3); }
  if (e instanceof RpcError && e.error === "E_RPC_VERSION") { console.error(`core: ${e.message}`); process.exit(4); }
  if (e instanceof ConfigInvalid) { console.error(`core: config invalid: ${e.errors.join("; ")}`); process.exit(2); }
  console.error("core: start failed", e); process.exit(1);
}
