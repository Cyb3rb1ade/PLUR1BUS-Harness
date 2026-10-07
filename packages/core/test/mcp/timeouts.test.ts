// ADR-014 §6: a hanging server means a timeout, a torn-down connection, a reaped process and no zombie.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { McpClientError } from "../../src/mcp/errors.ts";
import { FakeClock } from "./helpers/fake-clock.ts";
import { caller, capturingLogger, NODE, pidAlive, stdioDef, waitDead } from "./helpers/util.ts";

function setup(env: Record<string, string> = {}, timeouts: Record<string, number> = {}) {
  const clock = new FakeClock();
  const reg = new McpRegistry({ clock, logger: capturingLogger(), hostEnv: {}, policy: { allowedCommands: [NODE] } });
  const d = stdioDef({}, env);
  reg.register({ name: d.name, transport: d.transport, timeouts: { ...d.timeouts, callMs: 5_000, ...timeouts } });
  return { clock, reg };
}
const until = async (fn: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return fn(); };
const reject = async (p: Promise<unknown>): Promise<McpClientError> => { try { await p; } catch (e) { return e as McpClientError; } throw new Error("expected a rejection"); };

describe("mcp timeouts and cleanup", { timeout: 120_000 }, () => {
  it("a hung call times out, the wedged child is killed and reaped, and the next call starts a fresh server", async () => {
    // FIXTURE_WEDGE: the server ignores SIGTERM and survives stdin EOF, so only SIGKILL stops it.
    const { reg, clock } = setup({ FIXTURE_WEDGE: "1" });
    try {
      await reg.listTools("fixture", caller);
      const pid = reg.status("fixture", caller.agentId).pid!;
      const call = reg.callTool("fixture", "hang", {}, caller);
      assert.ok(await until(() => reg.status("fixture", caller.agentId).inFlight === 1));
      await new Promise((r) => setTimeout(r, 150)); // let the request reach the server
      await clock.advance(5_000);
      const err = await reject(call);
      assert.equal(err.code, "call-timeout");
      assert.equal(err.retryable, true);
      assert.ok(await waitDead(pid), "the wedged child must be killed");
      assert.throws(() => process.kill(pid, 0), (e: NodeJS.ErrnoException) => e.code === "ESRCH", "reaped: no zombie left behind");
      const s = reg.status("fixture", caller.agentId);
      assert.equal(s.state, "stopped");
      assert.equal(s.inFlight, 0);
      assert.equal(s.lastError?.code, "call-timeout");
      const ok = await reg.callTool("fixture", "echo", { text: "fresh" }, caller);
      assert.equal(ok.isError, false);
      assert.notEqual(reg.status("fixture", caller.agentId).pid, pid);
    } finally { await reg.shutdown(); }
  });

  it("a caller abort mid-call is `aborted`, distinct from a timeout, and also cleans up", async () => {
    const { reg } = setup();
    try {
      await reg.listTools("fixture", caller);
      const pid = reg.status("fixture", caller.agentId).pid!;
      const ac = new AbortController();
      const call = reg.callTool("fixture", "hang", {}, caller, ac.signal);
      await new Promise((r) => setTimeout(r, 200));
      ac.abort();
      assert.equal((await reject(call)).code, "aborted");
      assert.ok(await waitDead(pid));
      assert.equal(reg.status("fixture", caller.agentId).state, "stopped");
    } finally { await reg.shutdown(); }
  });

  it("an already-aborted signal never starts a server", async () => {
    const { reg } = setup();
    try {
      const ac = new AbortController(); ac.abort();
      assert.equal((await reject(reg.callTool("fixture", "echo", { text: "x" }, caller, ac.signal))).code, "aborted");
      const s = reg.status("fixture", caller.agentId);
      assert.deepEqual([s.state, s.starts, s.pid], ["stopped", 0, null]);
    } finally { await reg.shutdown(); }
  });

  it("a server that never answers initialize is a connect-timeout and its process is killed", async () => {
    const { reg, clock } = setup({ FIXTURE_STARTUP_MS: "60000", FIXTURE_WEDGE: "1" }, { connectMs: 2_000 });
    try {
      const p = reg.listTools("fixture", caller);
      await new Promise((r) => setTimeout(r, 400)); // the child is spawned and sleeping
      await clock.advance(2_000);
      const err = await reject(p);
      assert.equal(err.code, "connect-timeout");
      assert.equal(reg.status("fixture", caller.agentId).state, "stopped");
      assert.equal(reg.status("fixture", caller.agentId).starts, 0);
    } finally { await reg.shutdown(); }
  });

  it("shutdown while a call hangs kills the child and fails the call", async () => {
    const { reg } = setup({ FIXTURE_WEDGE: "1" });
    await reg.listTools("fixture", caller);
    const pid = reg.status("fixture", caller.agentId).pid!;
    const call = reg.callTool("fixture", "hang", {}, caller);
    await new Promise((r) => setTimeout(r, 200));
    await reg.shutdown();
    const err = await reject(call);
    assert.ok(["closed", "aborted", "protocol"].includes(err.code), err.code);
    assert.ok(await waitDead(pid), "child survived shutdown");
    assert.equal(pidAlive(pid), false);
  });
});
