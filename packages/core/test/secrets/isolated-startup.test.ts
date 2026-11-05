// A synchronous keyring call must not occupy Core's event loop or prevent startup/stop.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { killTree } from "../../../hostctl/src/processes.ts";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/isolated-core-startup.ts", import.meta.url));
const watchdogMs = 10_000;

async function runFixture(mode: string, env: NodeJS.ProcessEnv, t: TestContext): Promise<string> {
  const child = fork(fixture, [mode], {
    env, execArgv: ["--experimental-strip-types", "--experimental-test-module-mocks", "--conditions=source"],
    silent: true, detached: process.platform !== "win32",
  });
  const closed = once(child, "close");
  const log: string[] = [];
  let stdout = "";
  child.stdout!.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr!.setEncoding("utf8").on("data", (text: string) => log.push(text));
  const phases = new Set<string>();
  let remaining = watchdogMs;
  let since = 0;
  let active = 0;
  let expired = false;
  let terminating = false;
  const terminate = () => {
    if (terminating || child.exitCode !== null || child.signalCode !== null) return;
    terminating = true;
    void killTree(child).catch(() => child.kill("SIGKILL"));
  };
  const expire = () => { expired = true; terminate(); };
  // On Windows the standalone fixture imports Core and applies real filesystem ACLs. Charge
  // preload and shutdown to one cumulative budget; the node:test timeout covers the whole fixture.
  let timer: NodeJS.Timeout | undefined = process.platform === "win32" ? undefined : setTimeout(expire, watchdogMs);
  child.on("message", message => {
    if (message === "preload" || message === "shutdown") {
      phases.add(message);
      active++;
      if (active === 1 && process.platform === "win32") {
        since = performance.now();
        timer = setTimeout(expire, remaining);
      }
    } else if (message === "store-leave") {
      active--;
      if (active === 0 && process.platform === "win32") {
        clearTimeout(timer);
        remaining -= performance.now() - since;
        if (remaining <= 0) expire();
      }
    }
  });
  t.signal.addEventListener("abort", terminate, { once: true });
  try {
    const [code] = await closed;
    assert.equal(expired, false, "Core Store preload or shutdown exhausted the 10 s watchdog");
    assert.equal(code, 0, log.join("") + stdout);
    assert.equal(active, 0, "a measured lifecycle operation did not finish");
    assert.ok(phases.has("shutdown"), "fixture did not measure shutdown");
    if (mode !== "stop-before-store" && !mode.startsWith("ungated-")) {
      assert.ok(phases.has("preload"), "fixture did not measure Store preload");
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    t.signal.removeEventListener("abort", terminate);
  }
}

for (const mode of ["default", "injected", "file-hang"]) test(`Core ${mode} startup survives synchronously blocked Store I/O and discards unsafe diagnostics`, { timeout: 120_000 }, async t => {
  const env: NodeJS.ProcessEnv = { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" };
  delete env.PLUR1BUS_SECRETS_KEYRING;
  const stdout = await runFixture(mode, env, t);
  assert.ok(stdout.includes("synchronous-keyring-entered"), "the blocking native stand-in did not run");
  assert.ok(stdout.includes("core-heartbeat"), "Core's event loop did not run while the keyring was blocked");
});

for (const mode of ["test-internals", "production", "acl-refused", "failed-composition", "ungated-memory", "ungated-off", "stop-starting", "stop-before-store"]) test(`Core ${mode} keeps test isolation and startup cleanup bounded`, { timeout: 120_000 }, async t => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PLUR1BUS_SECRETS_KEYRING;
  delete env.PLUR1BUS_ALLOW_TEST_INTERNALS;
  if (mode.startsWith("ungated-")) env.PLUR1BUS_SECRETS_KEYRING = mode.slice("ungated-".length);
  const stdout = await runFixture(mode, env, t);
  assert.ok(stdout.includes(mode === "test-internals" ? "test-internals-memory" : "startup-refusal-cleaned"));
});
