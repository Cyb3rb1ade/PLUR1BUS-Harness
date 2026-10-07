import type { Risk } from "../policy/capabilities.ts";

export type HostPlatform = "darwin" | "win32" | "linux";

export interface ExecRequest {
  program: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface HostExec {
  run(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
}

export interface HostFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
}

export interface HostClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface HostOs {
  platform(): NodeJS.Platform;
  release(): string;
  arch(): string;
  type(): string;
  cpus(): { model: string; speed: number }[];
  totalmem(): number;
  freemem(): number;
  uptime(): number;
  homedir(): string;
  hostname(): string;
  networkInterfaces(): NodeJS.Dict<Array<{
    address: string;
    netmask: string;
    family: string | number;
    mac: string;
    internal: boolean;
    cidr: string | null;
  }>>;
  userInfo(): { username: string; uid: number; gid: number };
  loadavg(): number[];
}

export interface HostContext {
  platform: HostPlatform;
  exec: HostExec;
  fs: HostFs;
  os: HostOs;
  clock: HostClock;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  pid: number;
  uid: number;
  user: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface JsonSchema {
  type: string;
  [k: string]: unknown;
}

export interface HostTool {
  name: string;
  capability: string;
  riskClass: Risk;
  description: string;
  schema: { input: JsonSchema; output: JsonSchema };
  run(input: unknown, ctx: HostContext): Promise<unknown>;
}

export type HostOutcome<T = unknown> =
  | { isError: false; value: T }
  | { isError: true; error: { code: string; message: string } };

export const DEFAULT_TIMEOUT_MS = 30_000;
export const HARD_MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const HARD_MAX_OUTPUT_BYTES = 1024 * 1024;
export const CLIPBOARD_MAX_BYTES = 64 * 1024;

export function isHostPlatform(v: string): v is HostPlatform {
  return v === "darwin" || v === "win32" || v === "linux";
}

export function joinPath(platform: HostPlatform, ...parts: string[]): string {
  const sep = platform === "win32" ? "\\" : "/";
  const raw = parts.filter((p) => p !== "").join(sep);
  return platform === "win32" ? raw.replace(/[\\/]+/g, "\\") : raw.replace(/\/+/g, "/");
}

export function baseName(p: string): string {
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

export function asObject(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    const err = new Error("arguments must be an object") as Error & { code: string };
    err.code = "invalid_input";
    throw err;
  }
  return input as Record<string, unknown>;
}
