import type { DenyEntry, PathRoot } from '../../policy/paths.ts';
export type SandboxNetwork = 'none' | 'egress' | 'full';
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
  limits: { timeoutMs: number; cpuSeconds: number; memoryBytes: number; maxProcesses: number; maxOutputBytes: number };
  /** Trusted installation path, never model arguments. */
  limitsHelper: string;
}
export interface SandboxDetection {
  backend: 'seatbelt' | 'bubblewrap' | 'windows-restricted' | 'none';
  strength: 'strong' | 'partial' | 'none';
  available: boolean;
  reason: string;
  hint?: string;
}
export interface SandboxResult {
  exitCode: number | null; signal: string | null; stdout: string; stderr: string;
  stdoutTruncated: boolean; stderrTruncated: boolean; timedOut: boolean; aborted: boolean;
  resources: { durationMs: number; cpuSeconds: number; memoryBytes: number; maxProcesses: number; measured: false };
  sandbox: SandboxDetection & { network: SandboxNetwork; warnings: string[] };
}
export class SandboxFailure extends Error {
  readonly code = 'sandbox-unavailable';
  constructor(message: string) { super(message); this.name = 'SandboxFailure'; }
}
