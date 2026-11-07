// The core a transcript is recorded from or replayed against. `ts` is the TypeScript core, started in this process with
// the existing test seams (fixed clock and instance id, flat embedder). `rust` is the `plur1bus-core` front door (P4-10)
// with the TypeScript core behind it (the built packages/core/dist/core.js, flat embedder, no dream scheduler), in child
// processes; without the binary it fails loudly and never falls back to `ts`.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  constructor(bin: string) { super(`plur1bus-core not built (P4-03/P4-10): no binary at ${bin} (set PLUR1BUS_CORE_BIN or build it); refusing to fall back to ts`); this.name = "RustCoreNotBuilt"; }
}

/** The front door binary: `PLUR1BUS_CORE_BIN`, else the release build, else the debug build. */
export function rustCoreBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLUR1BUS_CORE_BIN) return resolve(env.PLUR1BUS_CORE_BIN);
  const release = resolve("target/release/plur1bus-core");
  return existsSync(release) ? release : resolve("target/debug/plur1bus-core");
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
  if (impl === "rust") return startRustTarget(opts);
  const saved: Record<string, string | undefined> = {};
  const env = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", ...(opts.env ?? {}) };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try {
    const home = parityHome();
    let now = FAKE_CLOCK_START_MS;
    const core = createCore({ home, instanceId: FAKE_INSTANCE_ID, clock: () => now++, testInternals: flatTestInternals(), dreams: { scheduler: false } });
    await core.start();
    return {
      impl: "ts", address: core.address, token: core.token,
      stop: async () => { try { await core.stop({ budgetMs: 5000 }); } finally { restore(); } },
    };
  } catch (e) { restore(); throw e; }
}

/** A fresh home with the parity configuration (agent `bernd`, the engine's background features off). */
function parityHome(): string {
  const home = tempDir("p1b-parity-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

/** The front door with the legacy core behind it, as `plur1bus core run` starts it with `core.impl: "rust"`. The legacy
 *  core cannot take the in-process fake clock and instance id; the comparison masks times, pids and uuids anyway. */
async function startRustTarget(opts: { env?: Record<string, string | undefined> }): Promise<ParityTarget> {
  const bin = rustCoreBin();
  if (!existsSync(bin)) throw new RustCoreNotBuilt(bin);
  const coreJs = resolve(process.env.PLUR1BUS_CORE_JS ?? "packages/core/dist/core.js");
  const home = parityHome();
  const env: NodeJS.ProcessEnv = { ...process.env, PLUR1BUS_NODE: process.execPath, PLUR1BUS_CORE_JS: coreJs,
    PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder" };
  for (const [k, v] of Object.entries(opts.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  const child = spawn(bin, ["serve", "--home", home], { env, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  const ready = await new Promise<{ address: string }>((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => rej(new Error("plur1bus-core not ready within 60 s")), 60_000);
    child.stdout!.on("data", (d: Buffer) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try { res(JSON.parse(buf.slice(0, nl))); } catch (e) { rej(e as Error); }
    });
    child.once("exit", (code) => { clearTimeout(timer); rej(new Error(`plur1bus-core exited before ready (${code})`)); });
  }).catch(async (e) => { child.kill("SIGKILL"); await exited; throw e; });
  child.stdout!.resume();
  return {
    impl: "rust", address: ready.address, token: readFileSync(layout(home).coreToken, "utf8").trim(),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await exited; clearTimeout(timer);
    },
  };
}
