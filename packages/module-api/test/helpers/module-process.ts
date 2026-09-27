// Runs the built fixture module (packages/module-fixture) as a real process against a temp home: module-api's runtime
// tests and the fixture's own tests share it.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type CoreClient } from "../../src/client.ts";
import { moduleAddress, moduleRunFiles } from "../../src/paths.ts";

const fixtureRoot = fileURLToPath(new URL("../../../module-fixture/", import.meta.url));

/** Rebuilds packages/module-fixture/dist from the current sources (esbuild, well under a second). */
export function buildFixture(): string {
  execFileSync(process.execPath, [join(fixtureRoot, "build.mjs")], { stdio: "inherit" });
  return join(fixtureRoot, "dist");
}

/** Copies the built module into `<home>/modules/<dir>`; `manifest` overrides module.json fields. */
export function installFixture(home: string, o: { dir?: string; manifest?: Record<string, unknown> } = {}): string {
  const dist = join(fixtureRoot, "dist");
  const dir = join(home, "modules", o.dir ?? "fixture");
  mkdirSync(dir, { recursive: true });
  for (const f of ["index.js", "package.json", "README.md"]) copyFileSync(join(dist, f), join(dir, f));
  const manifest = { ...JSON.parse(readFileSync(join(dist, "module.json"), "utf8")), ...o.manifest };
  writeFileSync(join(dir, "module.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

export interface ModuleProcess {
  child: ChildProcessWithoutNullStreams;
  instanceId: string;
  /** Resolves with the exit code (null when killed by a signal). */
  exited: Promise<number | null>;
  stderr(): string;
}

const live = new Set<ChildProcessWithoutNullStreams>();
/** SIGKILLs every module process a test left running (call from `after`). */
export function killLeftovers(): void { for (const c of live) c.kill("SIGKILL"); live.clear(); }

export function spawnModule(home: string, o: { name?: string; lifeline?: boolean } = {}): ModuleProcess {
  const name = o.name ?? "fixture";
  const instanceId = randomUUID();
  const args = [join(home, "modules", name, "index.js"), "--home", home, "--module", name, "--instance", instanceId, ...(o.lifeline === false ? [] : ["--lifeline", "stdin"])];
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  live.add(child);
  let err = "";
  child.stderr.on("data", (d) => { err += d.toString(); });
  child.stdout.resume();
  const exited = new Promise<number | null>((res) => child.once("exit", (code) => { live.delete(child); res(code); }));
  return { child, instanceId, exited, stderr: () => err };
}

/** Connects with `module.auth` once the module listens (its token file exists and a connect succeeds). */
export async function connectModule(home: string, name = "fixture", timeoutMs = 20_000): Promise<CoreClient> {
  const deadline = performance.now() + timeoutMs;
  const files = moduleRunFiles(home, name);
  let last: unknown;
  while (performance.now() < deadline) {
    if (existsSync(files.token)) {
      try { return await connect({ address: moduleAddress(home, name), token: readFileSync(files.token, "utf8").trim(), endpoint: "module", connectTimeoutMs: 1000 }); } catch (e) { last = e; }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`module ${name} did not come up: ${String(last)}`);
}

/** Polls `module.status` until `pred` holds. */
export async function waitStatus(c: CoreClient, pred: (s: any) => boolean, timeoutMs = 10_000): Promise<any> {
  const deadline = performance.now() + timeoutMs;
  let s: any;
  while (performance.now() < deadline) {
    s = await c.call("module.status", {});
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`module.status never matched: ${JSON.stringify(s)}`);
}

/** Resolves with the exit code, or rejects after `ms`. */
export function exitWithin(p: ModuleProcess, ms: number): Promise<number | null> {
  let timer: NodeJS.Timeout;
  return Promise.race([p.exited.finally(() => clearTimeout(timer)), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no exit within ${ms} ms; stderr: ${p.stderr()}`)), ms); })]);
}
