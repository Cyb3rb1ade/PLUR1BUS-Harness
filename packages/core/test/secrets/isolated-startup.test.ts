// A synchronous keyring call must not occupy Core's event loop or prevent startup/stop.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/isolated-core-startup.ts", import.meta.url));
const watchdogMs = 10_000;
const windows = process.platform === "win32";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

// Charge the union of open calls once. A nested call must neither reset nor double-charge the clock.
function storeBudget(expire: (op: string) => void, now = () => performance.now()) {
  const open = new Map<number, string>();
  const phases = new Set<string>();
  let lastId = 0, remaining = watchdogMs, since = 0;
  let timer: NodeJS.Timeout | undefined;
  const active = () => [...open.values()].join(", ");
  function record(event: string | undefined, id: number | undefined, op: string | undefined) {
    assert.ok(typeof id === "number" && typeof op === "string" && op.length > 0);
    if (event === "enter") {
      assert.equal(id, ++lastId, "out-of-order operation");
      if (!open.size) {
        since = now();
        timer = setTimeout(() => expire(active()), remaining);
      }
      open.set(id, op);
      phases.add(op);
    } else {
      assert.equal(event, "leave");
      assert.equal(open.get(id), op, "unmatched leave");
      open.delete(id);
      if (!open.size) {
        clearTimeout(timer);
        remaining -= now() - since;
        if (remaining <= 0) expire(op);
      }
    }
  }
  return { record, active, phases, close: () => clearTimeout(timer) };
}

test("the Store budget counts nested and disjoint calls and rejects unmatched messages", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100 });
  const expired: string[] = [];
  const budget = storeBudget(op => expired.push(op), Date.now);
  t.after(budget.close);
  budget.record("enter", 1, "preload");
  t.mock.timers.tick(3000);
  budget.record("enter", 2, "status");
  t.mock.timers.tick(2000);
  budget.record("leave", 2, "status");
  budget.record("leave", 1, "preload");
  t.mock.timers.tick(20_000);
  budget.record("enter", 3, "shutdown");
  t.mock.timers.tick(4999);
  assert.deepEqual(expired, []);
  t.mock.timers.tick(1);
  assert.deepEqual(expired, ["shutdown"]);
  assert.throws(() => budget.record("leave", 3, "wrong"), /unmatched leave/);
  assert.throws(() => budget.record("leave", 4, "shutdown"), /unmatched leave/);
});

async function runFixture(mode: string, env: NodeJS.ProcessEnv, t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "p1b-isolated-startup-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const child = fork(fixture, [mode, home], {
    env, execArgv: ["--experimental-strip-types", "--experimental-test-module-mocks", "--conditions=source"],
    silent: true, detached: !windows,
  });
  const closed = once(child, "close");
  let stdout = "", stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  const helpers = new Set<number>();
  let ready = false;
  let failure: Error | undefined;
  let cleanupError: Error | undefined;
  let termination: Promise<void> | undefined;
  function fail(error: Error) {
    if (failure) return;
    failure = error;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    termination = (async () => {
      if (windows) await promisify(execFile)("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-pid, "SIGKILL");
    })().catch(cause => {
      // Release our direct child even when the OS refuses tree cleanup. Report that refusal.
      child.kill("SIGKILL");
      cleanupError = new Error("could not terminate the fixture process tree", { cause });
    });
  }
  const budget = storeBudget(op => fail(new Error("10 s watchdog expired during " + op)));
  const abort = () => fail(new Error("fixture aborted by test runner"));
  const heartbeat = setTimeout(() => fail(new Error("fixture stopped responding: " + budget.active())), watchdogMs);
  // POSIX also keeps the original whole-fixture limit; every OS exercises the Store budget.
  const totalTimer = windows ? undefined : setTimeout(() => fail(new Error("10 s watchdog expired during " + budget.active())), watchdogMs);
  t.signal.addEventListener("abort", abort, { once: true });
  child.on("message", (message: { event?: string; op?: string; id?: number; pid?: number }) => {
    if (failure) return;
    try {
      const { event, op, id, pid } = message;
      if (!ready) {
        assert.equal(event, "ready", "missing fixture handshake");
        ready = true;
        heartbeat.refresh();
      } else if (event === "pulse") {
        heartbeat.refresh();
      } else if (event === "helper") {
        assert.ok(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0);
        helpers.add(pid);
      } else budget.record(event, id, op);
    } catch (error) { fail(error as Error); }
  });
  try {
    const [code] = await closed;
    budget.close();
    clearTimeout(heartbeat);
    clearTimeout(totalTimer);
    await termination;
    // A signalled process can take a moment to disappear. Never signal a helper by a sampled PID.
    const deadline = performance.now() + 2000;
    while ([...helpers].some(alive) && performance.now() < deadline) await delay(25);
    assert.ok(![...helpers].some(alive), "an isolated Store helper survived the fixture");
    if (mode === "blocked-control") {
      assert.ok(helpers.size > 0 && stdout.includes("synchronous-keyring-entered"), "control did not reach the blocking helper");
    }
    if (cleanupError) throw new AggregateError([failure, cleanupError], "fixture termination failed");
    if (failure) throw failure;
    assert.equal(code, 0, stderr + stdout);
    assert.ok(ready);
    assert.equal(budget.active(), "");
    const expected = ["seed", "shutdown"];
    if (mode !== "stop-before-store") {
      expected.push("construct");
      if (!mode.startsWith("ungated-")) expected.push("preloadRedaction");
    }
    if (mode === "test-internals") expected.push("status");
    if (["default", "injected", "file-hang"].includes(mode)) expected.push("status", "reveal", "lease");
    for (const op of expected) assert.ok(budget.phases.has(op), "fixture missed " + op);
    return stdout;
  } finally {
    budget.close();
    clearTimeout(heartbeat);
    clearTimeout(totalTimer);
    t.signal.removeEventListener("abort", abort);
  }
}

test("the parent interrupts a blocked Core thread and reaps its helper", { timeout: 120_000 }, async t => {
  const env = { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" };
  await assert.rejects(runFixture("blocked-control", env, t), /(?:10 s watchdog expired during |fixture stopped responding: )preloadRedaction/);
});

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
