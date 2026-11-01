import assert from "node:assert/strict";
import { test } from "node:test";
import { containedTerminal } from "../../src/external-agents/containment.ts";
import { acpPlatformAvailable, LaunchError, launchExternalAgent } from "../../src/external-agents/launcher.ts";

for (const platform of ["darwin", "win32"] as const) {
  test(`${platform} refuses ACP agents and discovery before validating argv or accessing cwd`, async () => {
    const cause = process.platform === "darwin" ? "macos-acceptance-pending" : undefined;
    for (const probe of [false, true]) {
      await assert.rejects(launchExternalAgent({ argv: [], cwd: "/missing-acp-cwd", platform, probe }),
        (error: unknown) => error instanceof LaunchError && error.reason === "sandbox-unavailable" && error.cause === cause);
    }
    assert.deepEqual(await containedTerminal({ argv: [], home: "/missing-acp-home", worktree: "/missing-acp-cwd", platform }),
      { ok: false, reason: "sandbox-unavailable", ...(cause ? { cause } : {}) });
  });
}

test("a platform override cannot enable ACP on an unsupported host", async () => {
  const launch = launchExternalAgent({ argv: [], cwd: "/missing-acp-cwd", probe: true, platform: "linux" });
  await assert.rejects(launch, (error: unknown) => error instanceof LaunchError &&
    error.reason === (process.platform === "linux" ? "argv" : "sandbox-unavailable"));
});

test("the Linux-only availability export and launcher agree for actual hosts and stricter overrides", async t => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  t.after(() => Object.defineProperty(process, "platform", original));
  for (const host of ["linux", "darwin", "win32", "freebsd"] as const) {
    Object.defineProperty(process, "platform", { ...original, value: host });
    for (const platform of [undefined, "linux", "darwin", "win32", "freebsd"] as const) {
      const available = host === "linux" && (platform === undefined || platform === "linux");
      assert.equal(acpPlatformAvailable(platform), available, `${host}/${platform}`);
      await assert.rejects(launchExternalAgent({ argv: [], cwd: "/missing-acp-cwd", probe: true, ...(platform ? { platform } : {}) }),
        (error: unknown) => error instanceof LaunchError && error.reason === (available ? "argv" : "sandbox-unavailable")
          && error.cause === (host === "darwin" ? "macos-acceptance-pending" : undefined));
    }
  }
});
