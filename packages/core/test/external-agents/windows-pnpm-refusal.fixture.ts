/** Windows selects this sharp refusal instead of the unchanged native pnpm acceptance callback. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";
import { containedTerminal } from "../../src/external-agents/containment.ts";

export async function windowsPnpmRefusal(t: TestContext): Promise<void> {
  assert.equal(process.platform, "win32");
  let attempts = 0;
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    t.mock.method(childProcess, method, () => { attempts++; throw new Error("Windows ACP must refuse before process creation"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await containedTerminal({ argv: [process.execPath, "pnpm.cjs", "install", "--offline"],
    home: "C:\\missing-acp-home", worktree: "C:\\missing-acp-worktree" }), { ok: false, reason: "sandbox-unavailable" });
  assert.equal(attempts, 0, "Windows refusal must precede pnpm resolution or process effects");
}
