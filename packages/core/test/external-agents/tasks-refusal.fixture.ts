/** Exercise the production launcher after a root/not-enforced probe, without starting a target. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "../../src/tools/sandbox/types.ts";

let spawns = 0, detections = 0, backendCalls = 0;
mock.method(childProcess, "spawn", () => { spawns++; throw new Error("target must not spawn"); });
syncBuiltinESMExports();
const backends = await import("../../src/tools/sandbox/backends.ts");
mock.module(new URL("../../src/tools/sandbox/backends.ts", import.meta.url).href, { namedExports: {
  ...backends,
  detectSandbox: async () => { detections++; return { backend: "bubblewrap", available: true, strength: "partial",
    reason: "fixture", tasks: { mechanism: "none", reason: "not-enforced", hint: "Run PLUR1BUS as a normal user." } }; },
  backendArgv: async () => { backendCalls++; throw new Error("unenforced cap must refuse before backend argv"); },
} });
// Isolate the Linux task gate on every test host; path-policy coverage lives in the sandbox tests.
mock.module(new URL("../../src/tools/sandbox/policy.ts", import.meta.url).href, { namedExports: {
  preparePolicy: async (policy: SandboxPolicy) => ({ ...policy, denied: [], runtimePaths: [], runtimeRoots: [] }),
} });
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
const { launchExternalAgent, LaunchError } = await import("../../src/external-agents/launcher.ts");
const root = mkdtempSync(join(tmpdir(), "acp-tasks-refusal-"));
try {
  await assert.rejects(launchExternalAgent({ argv: [process.execPath], cwd: root, home: root, probe: true }),
    (error: unknown) => error instanceof LaunchError && error.reason === "sandbox-unavailable" && error.cause === undefined);
  assert.equal(detections, 1, "the task probe result reached the production launcher");
  assert.equal(backendCalls, 0);
  assert.equal(spawns, 0);
} finally { rmSync(root, { recursive: true, force: true }); }
