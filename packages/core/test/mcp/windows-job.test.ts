import { it } from "node:test";
import assert from "node:assert/strict";
import { windowsLauncherEnv } from "../../src/mcp/windows-job.ts";

it("starts the Windows PowerShell launcher with its required environment, then lets child values win", () => {
  const env = windowsLauncherEnv(
    { Path: "child-path", MCP_TEST_VALUE: "child-value" },
    { PATH: "host-path", PSModulePath: "host-modules", HOST_ONLY: "host-value" },
  );

  assert.deepEqual(env, {
    PSModulePath: "host-modules",
    HOST_ONLY: "host-value",
    Path: "child-path",
    MCP_TEST_VALUE: "child-value",
  });
});
