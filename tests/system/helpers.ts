import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BIN = resolve(process.env.PLUR1BUS_BIN ?? "target/release/plur1bus");
export const CORE_JS = resolve(process.env.PLUR1BUS_CORE_JS ?? "packages/core/dist/core.js");
/** PLUR1BUS_REAL_MODELS=1: real embedder + reranker (downloads the models); otherwise the R17 flat-embedder seam. */
export const REAL = process.env.PLUR1BUS_REAL_MODELS === "1";

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

export interface RunningCore { child: ChildProcess; ready: { ready: boolean; address: string; pid: number }; readyMs: number }

/** `plur1bus core run` (execs node on POSIX); resolves on the core's one-line JSON ready message on stdout. */
export async function startCore(h: string): Promise<RunningCore> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PLUR1BUS_CORE_JS: CORE_JS, PLUR1BUS_NODE: process.execPath,
    ...(REAL ? {} : { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder" }),
  };
  const t0 = performance.now();
  const child = spawn(BIN, ["--home", h, "core", "run"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const ready = await new Promise<RunningCore["ready"]>((res, rej) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      child.stdout!.off("data", onData); child.off("exit", onExit);
      try { res(JSON.parse(buf.slice(0, nl))); } catch (e) { rej(new Error(`bad ready line: ${buf.slice(0, nl)} (${String(e)})`)); }
    };
    const onExit = (c: number | null, s: string | null) => rej(new Error(`core exited before ready: code ${c} signal ${s}`));
    child.stdout!.on("data", onData); child.once("exit", onExit);
  });
  child.stdout!.resume(); // keep draining anything written after the ready line
  return { child, ready, readyMs: performance.now() - t0 };
}

export async function killCore(core: RunningCore, signal: NodeJS.Signals): Promise<void> {
  const { child } = core;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill(signal);
  await exited;
}

export const stopCore = (core: RunningCore): Promise<void> => killCore(core, "SIGTERM");
