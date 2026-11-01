import assert from "node:assert/strict";
import { test } from "node:test";
import { containedTerminal } from "../../src/external-agents/containment.ts";
import { LaunchError, launchExternalAgent } from "../../src/external-agents/launcher.ts";

for (const platform of ["darwin", "win32"] as const) {
  test(`${platform} refuses ACP agents and discovery before validating argv or accessing cwd`, async () => {
    for (const probe of [false, true]) {
      await assert.rejects(launchExternalAgent({ argv: [], cwd: "/missing-acp-cwd", platform, probe }),
        (error: unknown) => error instanceof LaunchError && error.reason === "sandbox-unavailable");
    }
    assert.deepEqual(await containedTerminal({ argv: [], home: "/missing-acp-home", worktree: "/missing-acp-cwd", platform }),
      { ok: false, reason: "sandbox-unavailable" });
  });
}

test("a platform override cannot enable ACP on an unsupported host", async () => {
  const launch = launchExternalAgent({ argv: [], cwd: "/missing-acp-cwd", probe: true, platform: "linux" });
  await assert.rejects(launch, (error: unknown) => error instanceof LaunchError &&
    error.reason === (process.platform === "linux" ? "argv" : "sandbox-unavailable"));
});
