import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigInvalid } from "./config-load.ts";
import type { Core } from "./core.ts";
import { RpcError } from "./rpc/errors.ts";
import { InMemoryProfileSource, StaticCredentialResolver } from "./discovery/testing.ts";
import type { ProfileInfo } from "./discovery/ports.ts";
import { FakeChatProvider } from "./session/provider.ts";

// Under a supervisor, stdout and stderr are pipes that the supervisor reads. A SIGKILLed supervisor leaves them without
// a reader while the core lives on through its lifeline grace (S5, C1), so every later write fails with EPIPE. The
// core's own log file is the record: a lost stdio sink must never crash the core (e.g. midway through the grace-expiry stop).
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

/** Exit with one operator-readable line and no stack: a usage error is not a crash. */
function fail(message: string, code = 2): never { console.error(`core: ${message}`); process.exit(code); }
const oneLine = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(0, 500);

// The core that `stop` and the fatal handlers wind down; undefined while the arguments are still being read and the modules loaded.
let core: Core | undefined;
let stopping = false; let fatalSeen = false;
/** The one stop path for SIGTERM, SIGINT and a `core.shutdown` RPC: stop the core (engine, server, lock, run
 *  files, log flush), then exit `okCode` (0; 130 for SIGINT, the CLI convention for an interrupted process), or 1 when a
 *  stop step failed. An RPC's own budgetMs wins over config's. */
const stop = (why: string, budgetMs?: number, okCode = 0) => {
  if (stopping) { console.error(`core: ${why} ignored, stop already in progress`); return; } // core.stop() is idempotent, but a repeated request is still just noise here
  stopping = true;
  console.error(`core: ${why}, stopping`);
  if (!core) process.exit(okCode); // nothing started yet: there is nothing to wind down
  const c = core;
  // `core.shutdownBudgetMs` is live: the configuration running now (none before start: stop()'s own default).
  const budget = budgetMs ?? c.currentConfig()?.core.shutdownBudgetMs;
  // A stop step that never settles must not leave a process that no signal can end: the stop budget plus a margin is the hard limit.
  setTimeout(() => { console.error("core: stop did not finish in time, exiting"); process.exit(1); }, (budget ?? 30_000) + 5_000);
  c.stop(budget !== undefined ? { budgetMs: budget } : {})
    .then(() => process.exit(c.status().process.reason === "stop-step-failed" ? 1 : okCode))
    .catch((err) => { console.error(`core: stop failed: ${oneLine(err)}`); process.exit(1); });
};
/** An error nobody handled: one line (a stack carries install paths), wind the core down if it is up, exit 1. */
const fatal = (kind: string, err: unknown) => {
  console.error(`core: ${kind}: ${oneLine(err)}`);
  if (fatalSeen || !core) process.exit(1); // a second fatal while winding down, or nothing to wind down
  fatalSeen = true; stopping = true;
  setTimeout(() => process.exit(1), 5_000);
  core.stop({ budgetMs: 3_000 }).then(() => process.exit(1), () => process.exit(1));
};
process.on("uncaughtException", (e) => fatal("uncaught exception", e));
process.on("unhandledRejection", (e) => fatal("unhandled rejection", e));
process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT", undefined, 130));

let values: { home?: string | undefined; "test-internals"?: string | undefined; lifeline?: string | undefined; instance?: string | undefined };
try { ({ values } = parseArgs({ options: { home: { type: "string" }, "test-internals": { type: "string" }, lifeline: { type: "string" }, instance: { type: "string" } }, strict: true })); }
catch (e) { fail(e instanceof Error ? (e.message.split("\n")[0] ?? "bad arguments") : "bad arguments"); }
// `--flag=` (an empty value) is a mistake, not "use the default": `--home=` must not quietly start on the user's real home.
for (const [flag, v] of Object.entries(values)) if (v === "") fail(`--${flag} needs a value`);
// Supervised mode (S4): the supervisor spawns the core with `--lifeline stdin --instance <uuid>` and holds stdin's write end.
if (values.lifeline !== undefined && values.lifeline !== "stdin") fail(`--lifeline accepts only stdin, got ${values.lifeline}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (values.instance !== undefined && !UUID.test(values.instance)) fail(`--instance must be a UUID, got ${values.instance}`);
let testInternals: Record<string, unknown> | undefined;
if (values["test-internals"]) {
  if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") fail("--test-internals requires PLUR1BUS_ALLOW_TEST_INTERNALS=1");
  const variant = values["test-internals"];
  if (variant === "flat-embedder" || variant === "flat-embedder-cold") {
    // The width is the configured embedding's (core.ts resolves the factory), so the seam still fits the store after a
    // re-embedding switch; the re-embedding target provider gets its target's width the same way.
    const flat = (width: number) => () => Array.from({ length: width }, (_, i) => (i === 0 ? 1 : 0));
    // flat-embedder-cold (H3-R22): the first 2 embedQuery calls of this process (the warm-up probe and its
    // memory.list) take 350 ms each, one after the other (a cold model serves one inference at a time) — enough that a recall issued before the warm-up finished queues
    // behind the warm-up's probe and overruns the core's 600 ms hard budget.
    let coldCalls = variant === "flat-embedder-cold" ? 2 : 0; let coldChain: Promise<void> = Promise.resolve();
    const cold = async () => {
      if (coldCalls > 0) { coldCalls--; const mine = coldChain.then(() => new Promise<void>((r) => setTimeout(r, 350))); coldChain = mine; await mine; }
    };
    const embedder = (width: number, query: () => Promise<void> = async () => {}) => {
      const vector = flat(width); const one = async () => vector();
      return { embed: one, embedQuery: async () => { await query(); return vector(); }, embedPassage: one, embedBatch: async (t: string[]) => t.map(vector), shutdown: async () => {} };
    };
    // R17: force the null reranker alongside the flat embedder — production config always turns the reranker
    // on (engine-config.ts), so with >= 2 memories the engine would otherwise download the ONNX model in tests.
    testInternals = {
      embeddings: (width: number) => embedder(width, cold), reranker: null,
      reembeddingTargetProvider: ({ fingerprint }: { fingerprint: { dimensions: number } }) => embedder(fingerprint.dimensions),
    };
  } else if (variant === "crash-reject" || variant === "crash-throw" || variant === "stall") {
    // Fatal-handler and signal seams: they act before the core is created and never get past this point.
    if (variant === "crash-reject") void Promise.reject(new Error("boom"));
    if (variant === "crash-throw") setImmediate(() => { throw new Error("boom"); }); if (variant === "stall") console.error("core: test stall armed");
    setInterval(() => {}, 1 << 30); await new Promise(() => {});
  }
  else fail(`unknown --test-internals ${values["test-internals"]}`);
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
// Loaded only now: a usage error (or a fatal during startup) never pays for, nor depends on, the engine and its modules.
const { createCore } = await import("./core.ts");
core = createCore({
  ...(values.home ? { home: values.home } : {}), ...(testInternals ? { testInternals } : {}),
  ...(discoveryOptions ? { discovery: discoveryOptions } : {}), ...(chatProvider ? { chatProvider } : {}),
  ...(values.instance ? { instanceId: values.instance.toLowerCase() } : {}), ...(values.lifeline === "stdin" ? { lifeline: process.stdin, supervisorConfig: {} } : {}), // B7: 3 × 1 s config.watch
  onShutdownRequested: (budgetMs) => stop("core.shutdown", budgetMs),
  onOrphanGraceExpired: () => stop("lifeline grace expired"),
});

try {
  await core.start();
  console.log(JSON.stringify({ ready: true, address: core.address, pid: process.pid }));
} catch (e) {
  if (e instanceof RpcError && e.error === "E_LOCKED") { console.error(`core: ${e.message} (${e.detail ?? ""})`); process.exit(3); }
  if (e instanceof RpcError && e.error === "E_RPC_VERSION") { console.error(`core: ${e.message}`); process.exit(4); }
  if (e instanceof ConfigInvalid) { console.error(`core: config invalid: ${e.errors.join("; ")}`); process.exit(2); }
  console.error("core: start failed", e); process.exit(1);
}
