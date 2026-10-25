import type { DenyEntry, PathRoot } from '../../policy/paths.ts';
export type SandboxNetwork = 'none' | 'egress' | 'full';
/** Default tasks per sandboxed run, excluding bubblewrap's init. */
export const DEFAULT_MAX_TASKS = 512;
/** The measured process-cap mechanism, including why it cannot be used. */
export interface SandboxTasks { mechanism: 'namespace-limit' | 'fork-denied' | 'none'; reason: string; hint?: string }
export interface SandboxPolicy {
  home: string;
  userHome: string;
  cwd: string;
  readRoots: readonly PathRoot[];
  writeRoots: readonly PathRoot[];
  deny?: readonly DenyEntry[];
  network: SandboxNetwork;
  envAllow: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  /** CPU/memory are per process; maxTasks is per run, set inside its own user namespace. 0 disables the task cap. */
  limits: { timeoutMs: number; cpuSeconds: number; memoryBytes: number; maxOutputBytes: number; maxTasks: number };
  /** Trusted installation path, never model arguments. */
  limitsHelper: string;
}
export interface SandboxDetection {
  backend: 'seatbelt' | 'bubblewrap' | 'windows-restricted' | 'none';
  strength: 'strong' | 'partial' | 'none';
  available: boolean;
  tasks: SandboxTasks;
  reason: string;
  hint?: string;
}
export interface SandboxResult {
  exitCode: number | null; signal: string | null; stdout: string; stderr: string;
  stdoutTruncated: boolean; stderrTruncated: boolean; timedOut: boolean; aborted: boolean;
  resources: { durationMs: number; cpuSeconds: number; memoryBytes: number; maxTasks: number | null; measured: false };
  sandbox: SandboxDetection & { network: SandboxNetwork; warnings: string[] };
}
export class SandboxFailure extends Error {
  readonly code = 'sandbox-unavailable';
  constructor(message: string) { super(message); this.name = 'SandboxFailure'; }
}
