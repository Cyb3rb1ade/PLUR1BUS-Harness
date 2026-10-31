// Worktree containment for an external ACP agent. Paths go through the harness canonicaliser.
// The terminal sandbox keeps the worktree writable and the shared gitdir read-only. Windows has no backend.
import type { WatchdogDetail } from "./watchdog-detail.ts";
import { homedir } from "node:os";
import { launchExternalAgent, TRUSTED_PATH } from "./launcher.ts";
import type { AcpWorktreeMount } from "../tools/sandbox/acp-worktree.ts";
import { constants as fsc, openSync, closeSync, fstatSync, readSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { denyEntriesFor } from "../host-tools/denylist.ts";
import type { HostPlatform } from "../host-tools/types.ts";
import { canonicalisePath, openVerified, type CanonicalPath, type Identity, type DenyEntry, type PathRefusal } from "../policy/paths.ts";

export const FS_BYTES_MAX = 1_048_576;
export const TERMINAL_TIMEOUT_MS = 30_000;
export const TERMINAL_OUTPUT_MAX = 65_536;

const ENV_ALLOW = ["LANG", "LC_ALL", "TERM"] as const;

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
  signal?: AbortSignal;
}

function refusal(v: unknown): v is PathRefusal {
  return typeof v === "object" && v !== null && "ok" in v && (v as { ok: unknown }).ok === false;
}

function smallGitFile(path: string): string {
  const fd = openSync(path, fsc.O_RDONLY | fsc.O_NONBLOCK | fsc.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1 || stat.size > 4096) throw new ContainmentError("git-metadata", "invalid Git metadata");
    const bytes = Buffer.alloc(4096);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
  } finally { closeSync(fd); }
}

/** `.git` file of a linked worktree, its gitdir, and the shared config, hooks and info. */
export function gitDenyPaths(worktree: string): string[] {
  const gitFile = join(worktree, ".git");
  const out = [gitFile];
  let text = "";
  try { text = smallGitFile(gitFile); } catch { return out; }
  if (!text.startsWith("gitdir:")) return out;
  const gitdir = resolve(worktree, text.slice("gitdir:".length).trim());
  out.push(gitdir);
  try {
    const common = smallGitFile(join(gitdir, "commondir")).trim();
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
  const entries: DenyEntry[] = [...denyEntriesFor(homedir(), process.env, host), ...["run", "secrets", "config.json", "bin", "runtime"].map(p => ({ path: join(root.home, p) })), ...gitDenyPaths(root.worktree).map((path) => ({ path }))];
  // Credential paths stay denied. The whole home is denied only when the worktree is not inside it:
  // provisioned checkouts live under `<home>/state/worktrees`.
  if (!blocksWorktree(root.home, root.worktree)) entries.push({ path: root.home });
  return entries;
}

export async function containedPath(root: ContainmentRoot, requestPath: string, access: "read" | "write") {
  const platform = root.platform ?? process.platform;
  root.signal?.throwIfAborted();
  const found = await canonicalisePath(requestPath, {
    roots: [{ id: "worktree", path: root.worktree }],
    deny: denyFor(root),
    home: root.home,
    cwd: root.worktree,
    access,
    platform,
    windowsRules: root.windowsRules ?? platform === "win32",
  });
  root.signal?.throwIfAborted();
  if (refusal(found)) throw new ContainmentError(found.reason, found.detail);
  return found;
}

export async function containedRead(root: ContainmentRoot, requestPath: string): Promise<string> {
  const path = await containedPath(root, requestPath, "read");
  const opened = await openVerifiedFile(path, fsc.O_RDONLY | fsc.O_NONBLOCK, root.signal);
  try {
    const stat = await opened.stat();
    root.signal?.throwIfAborted();
    if (!stat.isFile()) throw new ContainmentError("not-regular", "file must be regular");
    if (stat.size > FS_BYTES_MAX) throw new ContainmentError("too-large", "file exceeds the read cap");
    const buf = Buffer.alloc(FS_BYTES_MAX + 1);
    const { bytesRead } = await opened.read(buf, 0, buf.length, 0);
    if (bytesRead > FS_BYTES_MAX) throw new ContainmentError("too-large", "file exceeds the read cap");
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally { await opened.close(); }
}

export async function containedWrite(root: ContainmentRoot, requestPath: string, text: string, approved?: CanonicalPath): Promise<void> {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength > FS_BYTES_MAX) throw new ContainmentError("too-large", "write exceeds the cap");
  const path = approved ?? await containedPath(root, requestPath, "write");
  if (approved && approved.canonical !== requestPath) throw new ContainmentError("identity-changed", "approved path changed");
  root.signal?.throwIfAborted();
  const opened = await openVerifiedFile(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_NONBLOCK, root.signal);
  try {
    const stat = await opened.stat();
    root.signal?.throwIfAborted();
    if (!stat.isFile()) throw new ContainmentError("not-regular", "file must be regular");
    await opened.truncate(0);
    root.signal?.throwIfAborted();
    await opened.writeFile(buf);
  } finally { await opened.close(); }
}

async function openVerifiedFile(path: Awaited<ReturnType<typeof containedPath>>, flags: number, signal?: AbortSignal) {
  const opened = await openVerified(path, flags, signal);
  if (refusal(opened)) throw new ContainmentError(opened.reason, opened.detail);
  return opened;
}

export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) env[key] = value;
  }
  env.PATH = TRUSTED_PATH;
  return env;
}

export interface HardlinkHit { count: number; path: string }

/** Regular files with more than one name. The worktree's own `.git` entry is not part of the scan. */
export function findHardlink(worktree: string): HardlinkHit | null {
  const root = realpathSync(worktree);
  const gitEntry = join(root, ".git");
  const stack = [root];
  let count = 0;
  let visited = 0;
  let sample = "";
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); }
    catch { throw new ContainmentError("hardlink-in-worktree", "unreadable"); }
    for (const name of names) {
      if (++visited > 20000) throw new ContainmentError("hardlink-in-worktree", "alias scan exceeds safety cap");
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

/** Bounded terminal result, shared by streaming snapshots and wait_for_exit. */
export interface TerminalResult { ok: true; exitCode: number | null; stdout: string; stderr: string; signal?: string; truncated?: boolean }
export interface TerminalRefusal { ok: false; reason: string; detail?: WatchdogDetail }

/** The same shared sandbox and native helper supervise agents, terminals and probes. */
export async function containedTerminal(o: {
  argv: readonly string[]; worktree: string; home: string; mount?: AcpWorktreeMount;
  cwd?: string; network?: boolean; platform?: NodeJS.Platform; timeoutMs?: number; signal?: AbortSignal;
  limitsHelper?: string; maxTasks?: number; memoryBytes?: number; outputByteLimit?: number;
  killSignal?: AbortSignal; approvedCommand?: string; approvedCwd?: string;
  approvedCommandIdentity?: Identity; approvedCwdIdentity?: Identity;
  onOutput?(output: string, truncated: boolean): void;
  log?: (event: string, fields?: Record<string, number | string>) => void;
}): Promise<TerminalResult | TerminalRefusal> {
  if ((o.platform ?? process.platform) === "win32") return { ok: false, reason: "sandbox-unavailable" };
  try {
    o.signal?.throwIfAborted();
    const hit = findHardlink(o.worktree);
    if (hit) {
      o.log?.("hardlink-in-worktree", { count: hit.count, path: hit.path });
      return { ok: false, reason: "hardlink-in-worktree" };
    }
    const limit = Math.min(o.outputByteLimit ?? TERMINAL_OUTPUT_MAX, TERMINAL_OUTPUT_MAX);
    if (!Number.isSafeInteger(limit) || limit < 1) return { ok: false, reason: "output-limit" };
    // cwd is checked independently and cannot select a sibling tree.
    const cwd = o.cwd ? (await containedPath({ worktree: o.worktree, home: o.home, ...(o.signal ? { signal: o.signal } : {}) }, o.cwd, "read")).canonical : o.worktree;
    o.signal?.throwIfAborted();
    if (o.approvedCwd && cwd !== o.approvedCwd) throw new ContainmentError("identity-changed", "approved cwd changed");
    const launchSignal = o.killSignal ? AbortSignal.any([...(o.signal ? [o.signal] : []), o.killSignal]) : o.signal;
    const handle = await launchExternalAgent({ ...o, cwd, ...(launchSignal ? { signal: launchSignal } : {}), timeoutMs: o.timeoutMs ?? TERMINAL_TIMEOUT_MS });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const take = (chunk: Buffer) => {
      const room = limit - bytes;
      if (chunk.length > room) truncated = true;
      const copy = Buffer.from(chunk.subarray(0, Math.max(0, room)));
      if (copy.length) chunks.push(copy);
      bytes += copy.length;
      o.onOutput?.(Buffer.concat(chunks).toString("utf8"), truncated);
    };
    handle.stdout.on("data", take);
    handle.stderr.on("data", take);
    const exitCode = await handle.exited;
    if (o.signal?.aborted) return { ok: false, reason: "aborted" };
    if (handle.exitStatus.reason) return { ok: false, reason: handle.exitStatus.reason };
    if (exitCode === 121) return { ok: false, reason: "task-limit-exceeded" };
    if (exitCode === 122) return { ok: false, reason: "rss-limit-exceeded" };
    if (exitCode === 125) return { ok: false, reason: "sandbox-unavailable", ...(handle.exitStatus.detail ? { detail: handle.exitStatus.detail } : {}) };
    return { ok: true, exitCode, stdout: Buffer.concat(chunks).toString("utf8"), stderr: "", truncated, ...(handle.exitStatus.signal ? { signal: handle.exitStatus.signal } : {}) };
  } catch (error) {
    if (o.killSignal?.aborted && !o.signal?.aborted) return { ok: true, exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" };
    return { ok: false, reason: o.signal?.aborted ? "aborted" : error instanceof ContainmentError
      ? error.reason : "sandbox-unavailable" };
  }
}
