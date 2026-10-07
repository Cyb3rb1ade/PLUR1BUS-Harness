// Ports and shapes of the `exec.run` tool (B3). Nothing here touches the OS: the runner works against these.
import type { AuditSink } from "../../rbac/audit.ts";
import type { ApprovalRequest, Context, Deps } from "../../policy/index.ts";
import type { DenyEntry, PathRoot } from "../../policy/paths.ts";

export type ExecMode = "deny" | "ask" | "allowlist";

export interface AllowedProgram {
  /** Bare name (`git`) or absolute path; compared exactly (case-folded on Windows). */
  program: string;
  /** Optional: every argument must match this regular expression (anchored by the caller's pattern). */
  argPattern?: string;
}

export interface ExecConfig {
  /** RULING: the default is `deny`; nothing runs until a person raises it. */
  mode: ExecMode;
  roots: readonly PathRoot[];
  deny?: readonly DenyEntry[];
  allowlist?: readonly AllowedProgram[];
  /** Names that may reach the child, inherited or requested. Default `DEFAULT_ENV_ALLOW`. */
  envAllow?: readonly string[];
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  maxMaxOutputBytes?: number;
}

export interface SpawnSpec {
  program: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface ExitInfo { code: number | null; signal: string | null }

export interface ProcessHandle {
  pid: number | undefined;
  onStdout(cb: (chunk: Uint8Array) => void): void;
  onStderr(cb: (chunk: Uint8Array) => void): void;
  /** Resolves once the process (and its output pipes) are done. Rejects on a spawn failure. */
  wait(): Promise<ExitInfo>;
  /** Ends the whole process tree. Idempotent; never rejects. */
  killTree(): Promise<void>;
}

export interface ProcessPort { spawn(spec: SpawnSpec): ProcessHandle }

export interface TimerPort {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ApprovalAnswer = { approved: boolean };
/** Asks a person. No port configured = nobody to ask = refused (fail closed). */
export interface ApprovalPort { request(req: ApprovalRequest): Promise<ApprovalAnswer> }

export interface ExecDeps {
  config: ExecConfig;
  process: ProcessPort;
  timers: TimerPort;
  audit: AuditSink;
  policy: Deps;
  /** The environment the child's allowlisted names are read from (default `process.env`). */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  approvals?: ApprovalPort;
  platform?: NodeJS.Platform;
  /** Who is calling; built by the dispatcher, never from tool arguments. */
  policyContext: Context;
  host?: string;
}

export interface ExecRequest {
  program: string;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export type ExecFailureCode =
  | "disabled" | "invalid-input" | "cwd-refused" | "program-refused" | "not-allowlisted" | "env-refused"
  | "policy-denied" | "approval-denied" | "audit-failed" | "spawn-failed";

export class ExecFailure extends Error {
  readonly code: ExecFailureCode;
  constructor(code: ExecFailureCode, message: string) {
    super(message);
    this.name = "ExecFailure";
    this.code = code;
  }
  toResult(): { isError: true; code: ExecFailureCode; message: string } {
    return { isError: true, code: this.code, message: this.message };
  }
}
