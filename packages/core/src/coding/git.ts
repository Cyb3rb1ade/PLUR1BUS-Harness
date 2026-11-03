/** CLI-1 read-only Git boundary. No repository filters, hooks, external diff, inherited Git routing or writes. */
import { execFileSync } from "node:child_process";
import { devNull } from "node:os";
import { RpcError } from "../rpc/errors.ts";

/** Bounded read-only Git command, using the D98 hardening plus a clean Git environment. */
export function codingGit(
  root: string,
  args: readonly string[],
  maxBytes = 4 * 1024 * 1024,
  environment: NodeJS.ProcessEnv = {},
): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: "0" }, environment);
  try {
    return execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        `diff.external=`,
        "-c",
        `core.attributesFile=${devNull}`,
        "-c",
        "core.quotePath=false",
        ...args,
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
        input: "",
        maxBuffer: maxBytes,
        timeout: 5000,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    // Git diagnostics may contain paths or repository data; do not echo captured stdout/stderr into an error.
    throw new RpcError("E_NOT_AVAILABLE", "bounded read-only Git command failed", { reason: "git-read-failed" });
  }
}

/** Removes only Git's line terminator, preserving spaces in a native filename. */
export const gitLine = (text: string): string => text.replace(/\r?\n$/u, "");
