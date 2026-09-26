import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BIN = resolve(process.env.PLUR1BUS_BIN ?? "target/release/plur1bus");
export const CORE_JS = resolve(process.env.PLUR1BUS_CORE_JS ?? "packages/core/dist/core.js");
/** PLUR1BUS_REAL_MODELS=1: real embedder + reranker (downloads the models); otherwise the R17 flat-embedder seam. */
export const REAL = process.env.PLUR1BUS_REAL_MODELS === "1";
/** Shared memory needs the engine's stable directory capabilities (fd-backed aliases via /proc/self/fd): Linux only at the pin. */
export const SHARED_MEMORY = process.platform === "linux";

/** A fresh temp home. With real models and PLUR1BUS_MODELS_CACHE set, `<home>/models` (the core's model
 *  cacheDir) is a symlink to that directory, so a CI cache can keep the ~600 MB download across runs. */
export function home(): string {
  const h = mkdtempSync(join(tmpdir(), "p1b-sys-"));
  const cache = process.env.PLUR1BUS_MODELS_CACHE;
  if (REAL && cache) { mkdirSync(cache, { recursive: true }); symlinkSync(resolve(cache), join(h, "models"), "dir"); }
  return h;
}

/** Runs the CLI against `h`; parses stdout as JSON unless `json: false`. Throws with stderr on a non-zero exit. */
export function cli(h: string, args: string[], opts: { json?: boolean; allowFail?: boolean } = {}): any {
  const all = [...(opts.json === false ? [] : ["--json"]), "--home", h, ...args];
  try {
    const out = execFileSync(BIN, all, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return opts.json === false ? out : JSON.parse(out);
  } catch (e: any) {
    if (!opts.allowFail) throw new Error(`${all.join(" ")}: exit ${e.status}\n${e.stderr}`);
    return { exit: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

export interface RunningCore {
  child: ChildProcess; ready: { ready: boolean; address: string; pid: number }; readyMs: number;
  /** Everything the core wrote to stderr so far (also tee'd to this process's stderr). */
  stderr: () => string;
}

const STARTUP_TIMEOUT_MS = REAL ? 120_000 : 30_000;

/** `plur1bus core run` (execs node on POSIX); resolves on the core's one-line JSON ready message on stdout.
 *  On a failed start (exit before ready, a bad ready line, a spawn error or the startup timeout) the child
 *  is killed and awaited before the promise rejects, so nothing leaks. */
export async function startCore(h: string): Promise<RunningCore> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PLUR1BUS_CORE_JS: CORE_JS, PLUR1BUS_NODE: process.execPath,
    ...(REAL ? {} : { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder" }),
  };
  const t0 = performance.now();
  const child = spawn(BIN, ["--home", h, "core", "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d: Buffer) => { err += String(d); process.stderr.write(d); });
  let ready: RunningCore["ready"];
  try {
    ready = await new Promise<RunningCore["ready"]>((res, rej) => {
      let buf = "";
      const timer = setTimeout(() => done(new Error(`core not ready within ${STARTUP_TIMEOUT_MS} ms`)), STARTUP_TIMEOUT_MS);
      const done = (e: Error | null, v?: RunningCore["ready"]) => {
        clearTimeout(timer);
        child.stdout!.off("data", onData); child.off("exit", onExit); child.off("error", onError);
        if (e) rej(e); else res(v!);
      };
      const onData = (d: Buffer) => {
        buf += String(d);
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        let v: RunningCore["ready"];
        try { v = JSON.parse(line); } catch (e) { done(new Error(`bad ready line: ${line} (${String(e)})`)); return; }
        if (v?.ready !== true || typeof v.address !== "string") { done(new Error(`bad ready line: ${line}`)); return; }
        done(null, v);
      };
      const onExit = (c: number | null, s: string | null) => done(new Error(`core exited before ready: code ${c} signal ${s}`));
      const onError = (e: Error) => done(new Error(`core spawn failed: ${e.message}`));
      child.stdout!.on("data", onData); child.once("exit", onExit); child.once("error", onError);
    });
  } catch (e) {
    await killChild(child, "SIGKILL");
    throw e;
  }
  child.stdout!.resume(); // keep draining anything written after the ready line
  return { child, ready, readyMs: performance.now() - t0, stderr: () => err };
}

async function killChild(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill(signal);
  await exited;
}

export const killCore = (core: RunningCore, signal: NodeJS.Signals): Promise<void> => killChild(core.child, signal);

/** The engine's own warnings when a rerank did not succeed (verbatim prefixes from the pinned engine):
 *  lib/recall-pipeline.js — `recall-pipeline: rerank failed/timeout, falling back to unreranked: …` (throw or timeout);
 *  lib/providers/reranker-chained.js — `reranker primary (<id>) failed: …` (provider error, with or without a fallback). */
export const RERANK_FAILURE = /recall-pipeline: rerank failed\/timeout, falling back to unreranked|reranker primary \([^)]*\) failed:/;

export const stopCore = (core: RunningCore): Promise<void> => killCore(core, "SIGTERM");
