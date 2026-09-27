import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BIN = resolve(process.env.PLUR1BUS_BIN ?? "target/release/plur1bus");
export const CORE_JS = resolve(process.env.PLUR1BUS_CORE_JS ?? "packages/core/dist/core.js");
/** PLUR1BUS_REAL_MODELS=1: real embedder + reranker (downloads the models); otherwise the R17 flat-embedder seam. */
export const REAL = process.env.PLUR1BUS_REAL_MODELS === "1";
/** The flat seam's variant: `flat-embedder` (default) or `flat-embedder-cold` (PLUR1BUS_SYSTEM_INTERNALS; the first 2
 *  query embeddings of each core process take 350 ms, so a recall that does not wait for the warm-up overruns). */
export const FLAT_INTERNALS = process.env.PLUR1BUS_SYSTEM_INTERNALS ?? "flat-embedder";
/** Shared memory needs the engine's stable directory capabilities (fd-backed aliases via /proc/self/fd): Linux only at
 *  the pin. Kept as the fallback a test can check before a core exists; once one is running, prefer
 *  {@link sharedMemorySupported}, which asks the engine itself instead of assuming from the platform name. */
export const SHARED_MEMORY = process.platform === "linux";

/** Whether the running core at `h` reports explicit shared memory as supported (E4, `core.status.engine.
 *  sharedMemory.supported`), read through `1staid check --json`'s `memory.shared` row (`ok` iff supported) rather
 *  than assuming from {@link SHARED_MEMORY}, so a system test gates on what the engine actually answered. */
export function sharedMemorySupported(h: string): boolean {
  const doc = cli(h, ["1staid", "check"]);
  const check = (doc.checks as Array<{ id: string; status: string }>).find((c) => c.id === "memory.shared");
  return check?.status === "ok";
}

/** A fresh temp home. With real models and PLUR1BUS_MODELS_CACHE set, `<home>/models` (the core's model
 *  cacheDir) is a symlink to that directory, so a CI cache can keep the ~600 MB download across runs. */
export function home(): string {
  const h = mkdtempSync(join(tmpdir(), "p1b-sys-"));
  const cache = process.env.PLUR1BUS_MODELS_CACHE;
  if (REAL && cache) { mkdirSync(cache, { recursive: true }); symlinkSync(resolve(cache), join(h, "models"), "dir"); }
  return h;
}

/** No single CLI call in a system test may hang the run: it is killed after this long (and then fails). */
const CLI_TIMEOUT_MS = 30_000;

/** Runs the CLI against `h`; parses stdout as JSON unless `json: false`. Throws with stderr on a non-zero exit. */
export function cli(h: string, args: string[], opts: { json?: boolean; allowFail?: boolean; env?: NodeJS.ProcessEnv } = {}): any {
  const all = [...(opts.json === false ? [] : ["--json"]), "--home", h, ...args];
  try {
    const out = execFileSync(BIN, all, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: CLI_TIMEOUT_MS, ...(opts.env ? { env: opts.env } : {}) });
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

/** The environment a core needs to start from this checkout: the built core.js, this Node, and the flat-embedder
 *  seam unless real models run. `extra` adds to it (e.g. `PLUR1BUS_SUPERVISOR_TIME_SCALE`, honoured only with
 *  `PLUR1BUS_ALLOW_TEST_INTERNALS=1`). A supervisor passes its environment on to the cores it spawns. */
export function coreEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, PLUR1BUS_CORE_JS: CORE_JS, PLUR1BUS_NODE: process.execPath,
    ...(REAL ? {} : { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: FLAT_INTERNALS }),
    ...extra,
  };
}

/** `plur1bus core run` (execs node on POSIX); resolves on the core's one-line JSON ready message on stdout.
 *  On a failed start (exit before ready, a bad ready line, a spawn error or the startup timeout) the child
 *  is killed and awaited before the promise rejects, so nothing leaks. */
export async function startCore(h: string): Promise<RunningCore> {
  const env = coreEnv();
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

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `probe` every `everyMs` until it returns a value other than `undefined`/`false`; throws `what` after `timeoutMs`. */
export async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs: number, everyMs = 100): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (performance.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Spec §6.3: polls `1staid check --json` every 250 ms until its `models.warm` check is `ok` (the engine's models
 *  are loaded, `core.status.engine.degraded === null`). Throws when the check is `fail` (a model failed to load) or
 *  after `timeoutMs`. Resolves with the time waited, in ms. */
export async function waitEngineReady(h: string, timeoutMs: number): Promise<number> {
  const t0 = performance.now(); let last: unknown = null;
  for (;;) {
    const r = cli(h, ["1staid", "check"], { allowFail: true });
    // `1staid check` exits 1 when any check fails; its JSON document is on stdout either way.
    const doc = "exit" in r ? JSON.parse(r.stdout) : r;
    const check = (doc.checks as Array<{ id: string; status: string }>).find((c) => c.id === "models.warm");
    last = check;
    if (check?.status === "ok") return performance.now() - t0;
    if (check?.status === "fail") throw new Error(`models failed to warm: ${JSON.stringify(check)}`);
    if (performance.now() - t0 > timeoutMs) throw new Error(`models not warm within ${timeoutMs} ms: ${JSON.stringify(last)}`);
    await sleep(250);
  }
}

/** B2: the core replays its journal in the background after `ready`. Polls `1staid check --json` every 250 ms until
 *  its `journal.backlog` check is `ok` (nothing journaled, no replay running). Resolves with the time waited, in ms. */
export async function waitJournalDrained(h: string, timeoutMs: number): Promise<number> {
  const t0 = performance.now(); let last: unknown = null;
  for (;;) {
    const r = cli(h, ["1staid", "check"], { allowFail: true });
    const doc = "exit" in r ? JSON.parse(r.stdout) : r;
    const check = (doc.checks as Array<{ id: string; status: string }>).find((c) => c.id === "journal.backlog");
    last = check;
    if (check?.status === "ok") return performance.now() - t0;
    if (performance.now() - t0 > timeoutMs) throw new Error(`journal not drained within ${timeoutMs} ms: ${JSON.stringify(last)}`);
    await sleep(250);
  }
}

/** `daemon start` (spawns `supervise` detached, waits for the core to be ready) with `coreEnv(extra)`. */
export const startDaemon = (h: string, extra: NodeJS.ProcessEnv = {}): any => cli(h, ["daemon", "start"], { env: coreEnv(extra) });

/** `daemon stop`; throws unless it exits 0. */
export const stopDaemon = (h: string): any => cli(h, ["daemon", "stop"]);

/** `daemon status --json` (H3-R25): `{ supervisor: { process, instanceId?, pid?, uptimeMs? }, children: ChildStatus[], service }`. */
export const daemonStatus = (h: string): any => cli(h, ["daemon", "status"]);

/** The answering supervisor's pid, or null when none answers. */
export function supervisorPid(h: string): number | null {
  return daemonStatus(h).supervisor?.pid ?? null;
}

/** The supervised core's status entry (`$defs/ChildStatus`), or null when no supervisor answers. */
export function coreChild(h: string): any | null {
  return daemonStatus(h).children?.[0] ?? null;
}

/** The supervised core's pid as the supervisor reports it, or null (no supervisor, or no core process right now). */
export function corePid(h: string): number | null {
  return coreChild(h)?.pid ?? null;
}

/** Whether `pid` names a live process. A zombie (exited, not yet reaped by its parent) counts as gone. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (e: any) { return e.code === "EPERM"; }
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z"; } catch { return false; }
  }
  try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); } catch { return false; }
}

/** Sends `signal` to `pid` and waits (≤ 10 s) until the process is gone. */
export async function killPid(pid: number, signal: NodeJS.Signals): Promise<void> {
  try { process.kill(pid, signal); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
  await waitFor(`pid ${pid} to exit after ${signal}`, () => !alive(pid), 10_000, 20);
}

/** Plays the OS service manager: spawns `plur1bus --home h supervise` detached, with the same environment as
 *  `startCore` (plus `extra`), and waits (≤ 10 s) until that new supervisor answers `daemon status`. */
export async function restartSupervisor(h: string, extra: NodeJS.ProcessEnv = {}): Promise<number> {
  const child = spawn(BIN, ["--home", h, "supervise"], { env: coreEnv(extra), stdio: "ignore", detached: true });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("supervise did not spawn");
  try {
    return await waitFor(`supervisor ${pid} to answer`, () => supervisorPid(h) === pid && pid, 10_000);
  } catch (e) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    throw e;
  }
}

/** Every process whose command line names `--home <h>` (supervisor, cores, stray CLI calls). */
export function homePids(h: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", "--", `--home ${h}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
  } catch { return []; } // pgrep exits 1 when nothing matches
}

/** Cleanup for a test's `finally`: SIGKILLs whatever still runs against `h`, so a failed test never leaves a
 *  supervisor or core behind (POSIX; a no-op on Windows, where the system tests do not run). */
export async function reapHome(h: string): Promise<void> {
  if (process.platform === "win32") return;
  const left = homePids(h);
  for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const pid of left) { try { await waitFor(`pid ${pid} to exit`, () => !alive(pid), 5000, 20); } catch { /* reported by the test itself */ } }
}
