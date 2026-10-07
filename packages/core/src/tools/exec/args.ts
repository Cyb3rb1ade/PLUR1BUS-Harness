// Program and argument validation. Arguments are an array handed to the OS as is (no shell), so there is nothing
// to escape; what is refused is what cannot be passed faithfully or must never be started from here.
import { basename } from "node:path";
import { ExecFailure, type AllowedProgram } from "./types.ts";

const MAX_ARGS = 256;
const MAX_ARG_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

// RULING: shell interpreters are never started (they would turn the argument array back into a command string),
// and privilege escalators belong to `os.privilege`, which this tool does not serve. Fail closed, in every tier.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish", "cmd", "powershell", "pwsh", "wsl", "busybox"]);
const PRIVILEGED = new Set(["sudo", "doas", "pkexec", "su", "runas", "gsudo"]);
const WIN_SCRIPT = /\.(bat|cmd)$/i;

export function programKey(program: string): string {
  return basename(program.replaceAll("\\", "/")).toLowerCase().replace(/\.(exe|com)$/, "");
}

export function validateProgram(program: unknown): string {
  if (typeof program !== "string" || program.length === 0 || program.length > 4096) throw new ExecFailure("invalid-input", "program must be a non-empty string");
  if (/[\0\r\n]/.test(program)) throw new ExecFailure("invalid-input", "program contains a control character");
  if (program !== program.trim()) throw new ExecFailure("invalid-input", "program has surrounding whitespace");
  if (program.startsWith("-")) throw new ExecFailure("program-refused", "program may not start with '-'");
  if (WIN_SCRIPT.test(program)) throw new ExecFailure("program-refused", "batch scripts are not started (they re-parse arguments as a command line)");
  const key = programKey(program);
  if (SHELLS.has(key)) throw new ExecFailure("program-refused", `${key} is a shell interpreter; pass the program and its arguments directly`);
  if (PRIVILEGED.has(key)) throw new ExecFailure("program-refused", `${key} escalates privileges; not available through exec.run`);
  return program;
}

export function validateArgs(args: unknown): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw new ExecFailure("invalid-input", `args must be an array of at most ${MAX_ARGS} strings`);
  let total = 0;
  for (const a of args) {
    if (typeof a !== "string") throw new ExecFailure("invalid-input", "every argument must be a string");
    if (a.includes("\0")) throw new ExecFailure("invalid-input", "an argument contains NUL");
    const n = Buffer.byteLength(a);
    total += n;
    if (n > MAX_ARG_BYTES || total > MAX_TOTAL_BYTES) throw new ExecFailure("invalid-input", "arguments too large");
  }
  return [...args];
}

/** The allowlist entry for `program`, or undefined. A bare entry matches the bare name only, a path entry that exact path. */
export function findAllowed(list: readonly AllowedProgram[] | undefined, program: string, windows: boolean): AllowedProgram | undefined {
  const fold = (s: string) => (windows ? s.toLowerCase() : s);
  return (list ?? []).find((e) => fold(e.program) === fold(program));
}

export function argsMatchPattern(entry: AllowedProgram, args: readonly string[]): boolean {
  if (entry.argPattern === undefined) return true;
  let re: RegExp;
  try { re = new RegExp(entry.argPattern, "u"); } catch { return false; } // an unreadable pattern allows nothing
  return args.every((a) => re.test(a));
}
