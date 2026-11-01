// SPDX-License-Identifier: MIT
/** Linux verifier adapter reusing Core's mount plan with explicit trusted, read-only compiler/runtime roots. */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifierBwrapArgv } from "../../../../../packages/core/src/collab/verifier.ts";
import { runOwnedCommand } from "./process.mjs";

/** Implement VerifierPort without a shell or isolation fallback; the caller validates every additional runtime root. */
export function runtimeVerifier(runtimeRoots) {
  return {
    async run(root, command, options) {
      const temp = await realpath(await mkdtemp(join(tmpdir(), "p1b-team-verifier-")));
      try {
        const argv = verifierBwrapArgv({
          root,
          temp,
          program: command.argv[0],
          args: command.argv.slice(1),
          networkAllowed: false,
        });
        const mounts = runtimeRoots.flatMap((path) => ["--ro-bind", path, path]);
        argv.splice(argv.indexOf("--dev"), 0, ...mounts);
        const result = await runOwnedCommand({
          program: "/usr/bin/bwrap",
          args: argv,
          cwd: root,
          env: { PATH: "/usr/bin:/bin", HOME: temp, TMPDIR: temp, CI: "1" },
          timeoutMs: 60000,
          signal: options.signal,
        });
        return {
          ok: result.code === 0 && !result.reason,
          exitCode: result.code,
          output: result.stdout,
          ...(result.reason ? { reason: result.reason } : {}),
        };
      } catch {
        return { ok: false, exitCode: null, output: "", reason: "verifier-unavailable" };
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  };
}
