// The core a transcript is recorded from or replayed against. `ts` is the TypeScript core, started in this process with
// the existing test seams (fixed clock and instance id, flat embedder). `rust` is the `plur1bus-core` front door; the
// binary does not exist before P4-03/P4-10, so asking for it fails loudly and never falls back to `ts`.
import { writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../packages/core/src/core.ts";
import { layout } from "../../packages/core/src/paths.ts";
import { flatTestInternals } from "../../packages/core/test/helpers/flat-embedder.ts";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";

export type CoreImpl = "ts" | "rust";

export interface ParityTarget {
  readonly impl: CoreImpl;
  readonly address: string;
  /** The handshake credential of this core; substituted for the recorded `<token>` placeholder at replay. */
  readonly token: string;
  stop(): Promise<void>;
}

/** The fixed values every `ts` target runs with, so recordings do not depend on the wall clock or a random instance id. */
export const FAKE_CLOCK_START_MS = Date.UTC(2026, 0, 1);
export const FAKE_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";

export class RustCoreNotBuilt extends Error {
  constructor() { super("plur1bus-core not built (P4-03/P4-10): PLUR1BUS_CORE_IMPL=rust has no binary to start yet; refusing to fall back to ts"); this.name = "RustCoreNotBuilt"; }
}

/** `PLUR1BUS_CORE_IMPL` (default `ts`); any other value is an error, not a default. */
export function coreImplFromEnv(env: NodeJS.ProcessEnv = process.env): CoreImpl {
  const v = env.PLUR1BUS_CORE_IMPL;
  if (v === undefined || v === "" || v === "ts") return "ts";
  if (v === "rust") return "rust";
  throw new Error(`PLUR1BUS_CORE_IMPL must be "ts" or "rust", got ${JSON.stringify(v)}`);
}

/** Starts a core. `env` is applied to this process for the core's lifetime (the RPC server reads the recorder
 *  variables when it is created, inside `start()`), then restored by `stop()`. */
export async function startTarget(impl: CoreImpl = coreImplFromEnv(), opts: { env?: Record<string, string | undefined> } = {}): Promise<ParityTarget> {
  if (impl === "rust") throw new RustCoreNotBuilt();
  const saved: Record<string, string | undefined> = {};
  const env = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", ...(opts.env ?? {}) };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try {
    const home = tempDir("p1b-parity-");
    const cfg = defaults(); cfg.agents.bernd = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
    writeFileSync(layout(home).configPath, JSON.stringify(cfg));
    let now = FAKE_CLOCK_START_MS;
    const core = createCore({ home, instanceId: FAKE_INSTANCE_ID, clock: () => now++, testInternals: flatTestInternals(), dreams: { scheduler: false } });
    await core.start();
    return {
      impl: "ts", address: core.address, token: core.token,
      stop: async () => { try { await core.stop({ budgetMs: 5000 }); } finally { restore(); } },
    };
  } catch (e) { restore(); throw e; }
}
