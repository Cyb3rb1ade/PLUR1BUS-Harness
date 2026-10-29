// Hardened git for the worktree provisioner. Fixed argv, no shell, no inherited environment.
// The -c switches match gitText in collab/verifier.ts: hooks, fsmonitor, textconv and the global config stay off.
import { execFileSync } from "node:child_process";

const NULL_DEV = process.platform === "win32" ? "NUL" : "/dev/null";

/** Flags that must be on every git invocation this package starts. */
export const GIT_HARDENING = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${NULL_DEV}`,
  "-c", `core.excludesFile=${NULL_DEV}`,
] as const;

export interface GitCall { file: "git"; args: readonly string[]; cwd?: string }

export interface GitExec {
  run(args: readonly string[], cwd?: string): string;
}

/** Full argv the process actually receives, including the hardening flags. */
export function gitArgv(args: readonly string[], cwd?: string): string[] {
  const body = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : [...args];
  return [...GIT_HARDENING, ...(cwd ? ["-C", cwd] : []), ...body];
}

export function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEV,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

export const realGit: GitExec = {
  run(args, cwd) {
    return execFileSync("git", gitArgv(args, cwd), {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      windowsHide: true,
    });
  },
};

let current: GitExec = realGit;

/** Tests install a recorder. Production leaves this unset. */
export function setGitExec(exec: GitExec | null): void {
  current = exec ?? realGit;
}

export function git(args: readonly string[], cwd?: string): string {
  return current.run(args, cwd);
}
