// Worktree containment for an external ACP agent. Paths go through the harness canonicaliser.
// The terminal sandbox keeps the worktree writable and the shared gitdir read-only. Windows has no backend.
import { spawn } from "node:child_process";
import { constants as fsc, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { denyEntriesFor } from "../host-tools/denylist.ts";
import type { HostPlatform } from "../host-tools/types.ts";
import { canonicalisePath, type DenyEntry, type PathRefusal } from "../policy/paths.ts";

export const FS_BYTES_MAX = 1_048_576;
export const TERMINAL_TIMEOUT_MS = 30_000;
export const TERMINAL_OUTPUT_MAX = 65_536;

const ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "HOME"] as const;

export class ContainmentError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ContainmentError";
    this.reason = reason;
  }
}

export interface ContainmentRoot {
  worktree: string;
  /** Harness or user home. Writes here are refused, and the path is on the deny-list. */
  home: string;
  platform?: NodeJS.Platform;
  windowsRules?: boolean;
}

function refusal(v: unknown): v is PathRefusal {
  return typeof v === "object" && v !== null && "ok" in v && (v as { ok: unknown }).ok === false;
}

/** `.git` file of a linked worktree, its gitdir, and the shared config, hooks and info. */
export function gitDenyPaths(worktree: string): string[] {
  const gitFile = join(worktree, ".git");
  const out = [gitFile];
  let text = "";
  try { text = readFileSync(gitFile, "utf8"); } catch { return out; }
  if (!text.startsWith("gitdir:")) return out;
  const gitdir = resolve(worktree, text.slice("gitdir:".length).trim());
  out.push(gitdir);
  try {
    const common = readFileSync(join(gitdir, "commondir"), "utf8").trim();
    const main = resolve(gitdir, common);
    out.push(main, join(main, "config"), join(main, "hooks"), join(main, "info"));
  } catch { /* a linked worktree without commondir still denies its gitdir */ }
  return out;
}

/** True when `parent` is the worktree or a directory that contains it. Denying that prefix would freeze the checkout. */
function blocksWorktree(parent: string, worktree: string): boolean {
  let base = parent;
  let child = worktree;
  try { base = realpathSync(parent); } catch { base = resolve(parent); }
  try { child = realpathSync(worktree); } catch { child = resolve(worktree); }
  return child === base || child.startsWith(base.endsWith(sep) ? base : base + sep);
}

function denyFor(root: ContainmentRoot): DenyEntry[] {
  const platform = root.platform ?? process.platform;
  const host: HostPlatform = platform === "win32" ? "win32" : platform === "linux" ? "linux" : "darwin";
  const entries: DenyEntry[] = [...denyEntriesFor(root.home, {}, host), ...gitDenyPaths(root.worktree).map((path) => ({ path }))];
  // Credential paths stay denied. The whole home is denied only when the worktree is not inside it:
  // provisioned checkouts live under `<home>/state/worktrees`.
  if (!blocksWorktree(root.home, root.worktree)) entries.push({ path: root.home });
  return entries;
}

async function canon(root: ContainmentRoot, requestPath: string, access: "read" | "write") {
  const platform = root.platform ?? process.platform;
  const found = await canonicalisePath(requestPath, {
    roots: [{ id: "worktree", path: root.worktree }],
    deny: denyFor(root),
    home: root.home,
    cwd: root.worktree,
    access,
    platform,
    windowsRules: root.windowsRules ?? platform === "win32",
  });
  if (refusal(found)) throw new ContainmentError(found.reason, found.detail);
  return found;
}

export async function containedRead(root: ContainmentRoot, requestPath: string): Promise<string> {
  const path = await canon(root, requestPath, "read");
  const opened = await openVerifiedFile(path, fsc.O_RDONLY);
  try {
    const buf = await opened.readFile();
    if (buf.byteLength > FS_BYTES_MAX) throw new ContainmentError("too-large", "file exceeds the read cap");
    return buf.toString("utf8");
  } finally { await opened.close(); }
}

export async function containedWrite(root: ContainmentRoot, requestPath: string, text: string): Promise<void> {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength > FS_BYTES_MAX) throw new ContainmentError("too-large", "write exceeds the cap");
  const path = await canon(root, requestPath, "write");
  const opened = await openVerifiedFile(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC);
  try { await opened.writeFile(buf); } finally { await opened.close(); }
}

async function openVerifiedFile(path: Awaited<ReturnType<typeof canon>>, flags: number) {
  const { openVerified } = await import("../policy/paths.ts");
  const opened = await openVerified(path, flags);
  if (refusal(opened)) throw new ContainmentError(opened.reason, opened.detail);
  return opened;
}

export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) env[key] = value;
  }
  if (!env.PATH) env.PATH = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin";
  return env;
}

function seatbelt(worktree: string, denies: readonly string[], network: boolean): string {
  const wt = realpathSync(worktree);
  const extra = denies.map((p) => {
    if (!existsSync(p)) return "";
    const real = realpathSync(p);
    const filter = statSync(real).isDirectory() ? `subpath ${JSON.stringify(real)}` : `literal ${JSON.stringify(real)}`;
    return `(deny file-write* (${filter}))`;
  }).join("");
  const net = network ? "" : "(deny network*)";
  // Measured on this Mac on 2026-10-29. `(allow file-link (subpath DIR))` permits a link only when
  // both paths are inside DIR. A second subpath filter allows a link whose source is outside the
  // worktree. That is not a source rule, so new hard links are refused outright.
  return `(version 1)(allow default)(deny file-link)${net}(deny file-write* (require-all (require-not (subpath ${JSON.stringify(wt)})) (require-not (literal "/dev/null"))))${extra}`;
}

export interface HardlinkHit { count: number; path: string }

/** Regular files with more than one name. The worktree's own `.git` entry is not part of the scan. */
export function findHardlink(worktree: string): HardlinkHit | null {
  const root = realpathSync(worktree);
  const gitEntry = join(root, ".git");
  const stack = [root];
  let count = 0;
  let sample = "";
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); }
    catch { throw new ContainmentError("hardlink-in-worktree", "unreadable"); }
    for (const name of names) {
      const path = join(dir, name);
      if (path === gitEntry) continue;
      let st;
      try { st = lstatSync(path); }
      catch { throw new ContainmentError("hardlink-in-worktree", "unreadable"); }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { stack.push(path); continue; }
      if (!st.isFile() || st.nlink <= 1) continue;
      count += 1;
      if (!sample) sample = relative(root, path).split(sep).join("/");
    }
  }
  return count > 0 ? { count, path: sample } : null;
}

function bwrapArgv(worktree: string, denies: readonly string[], argv: readonly string[], network: boolean): string[] {
  const wt = realpathSync(worktree);
  const args = ["/usr/bin/bwrap", "--die-with-parent", "--unshare-all", ...(network ? ["--share-net"] : [])];
  for (const p of ["/usr", "/bin", "/lib", "/lib64", "/etc"]) if (existsSync(p)) args.push("--ro-bind", p, p);
  const nodeDir = dirnameSafe(process.execPath);
  if (nodeDir && !["/usr", "/bin"].some((p) => nodeDir === p || nodeDir.startsWith(p + "/"))) args.push("--ro-bind", nodeDir, nodeDir);
  args.push("--dev", "/dev", "--proc", "/proc", "--bind", wt, wt);
  for (const p of denies) {
    if (!existsSync(p)) continue;
    const real = realpathSync(p);
    args.push("--ro-bind", real, real);
  }
  args.push("--chdir", wt, ...argv);
  return args;
}

function dirnameSafe(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

export interface TerminalResult { ok: true; exitCode: number | null; stdout: string; stderr: string }
export interface TerminalRefusal { ok: false; reason: "sandbox-unavailable" | "argv" | "timeout" | "aborted" | "spawn-failed" | "hardlink-in-worktree" }

/** Absolute argv, no shell. Windows is refused. The gitdir stays read-only inside the sandbox. */
export function containedTerminal(o: {
  argv: readonly string[];
  worktree: string;
  home: string;
  network?: boolean;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (event: string, fields?: Record<string, number | string>) => void;
}): Promise<TerminalResult | TerminalRefusal> {
  const platform = o.platform ?? process.platform;
  if (platform === "win32") return Promise.resolve({ ok: false, reason: "sandbox-unavailable" });
  if (!o.argv.length || o.argv.some((a) => typeof a !== "string" || a.includes("\0") || !isAbsolute(a))) {
    return Promise.resolve({ ok: false, reason: "argv" });
  }
  try {
    const hit = findHardlink(o.worktree);
    if (hit) {
      o.log?.("hardlink-in-worktree", { count: hit.count, path: hit.path });
      return Promise.resolve({ ok: false, reason: "hardlink-in-worktree" });
    }
  } catch (e) {
    if (e instanceof ContainmentError) return Promise.resolve({ ok: false, reason: "hardlink-in-worktree" });
    return Promise.resolve({ ok: false, reason: "spawn-failed" });
  }
  const denies = [o.home, ...gitDenyPaths(o.worktree)].filter((p) => !blocksWorktree(p, o.worktree));
  const network = o.network === true;
  let bin: string;
  let argv: string[];
  if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    bin = "/usr/bin/sandbox-exec";
    argv = ["-p", seatbelt(o.worktree, denies, network), ...o.argv];
  } else if (platform === "linux" && existsSync("/usr/bin/bwrap")) {
    const full = bwrapArgv(o.worktree, denies, o.argv, network);
    bin = full[0]!;
    argv = full.slice(1);
  } else return Promise.resolve({ ok: false, reason: "sandbox-unavailable" });
  const timeoutMs = o.timeoutMs ?? TERMINAL_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    let stdout = "", stderr = "", reason: string | undefined;
    const child = spawn(bin, argv, { cwd: o.worktree, detached: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv(), windowsHide: true });
    const stop = (why: string) => {
      if (reason) return;
      reason = why;
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }, 100).unref();
    };
    const take = (into: "out" | "err") => (chunk: Buffer) => {
      const cur = into === "out" ? stdout : stderr;
      if (cur.length >= TERMINAL_OUTPUT_MAX) stop("output-limit");
      else if (into === "out") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    child.once("error", () => { reason = "spawn-failed"; });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const abort = () => stop("aborted");
    if (o.signal?.aborted) abort(); else o.signal?.addEventListener("abort", abort, { once: true });
    child.once("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
      if (reason === "timeout" || reason === "aborted" || reason === "spawn-failed") resolvePromise({ ok: false, reason });
      else resolvePromise({ ok: true, exitCode: code, stdout, stderr });
    });
  });
}

