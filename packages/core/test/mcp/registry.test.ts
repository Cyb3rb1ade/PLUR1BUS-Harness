import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { McpClientError } from "../../src/mcp/errors.ts";
import { startFixtureHttp, type FixtureHttp } from "./helpers/fixture-http.ts";
import { FakeClock } from "./helpers/fake-clock.ts";
import { caller, capturingLogger, NODE, stdioDef, waitDead } from "./helpers/util.ts";

const IDLE = 15 * 60_000;
const agentB = { agentId: "friday", principal: "user:v1:other" };

function setup(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const logger = capturingLogger();
  const reg = new McpRegistry({ clock, logger, hostEnv: {}, policy: { allowedCommands: [NODE] }, ...over });
  const def = (o: Record<string, unknown> = {}) => { const d = stdioDef(o); return { name: d.name, scope: d.scope, transport: d.transport, timeouts: d.timeouts, ...o }; };
  return { clock, logger, reg, def };
}
const codeOf = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof McpClientError ? e.code : `other:${String(e)}`; } };

describe("mcp registry: lifecycle on a fake clock", { timeout: 120_000 }, () => {
  it("registering starts nothing; the first use spawns lazily", async () => {
    const { reg, def } = setup();
    try {
      reg.register(def());
      const s0 = reg.status("fixture", caller.agentId);
      assert.deepEqual([s0.state, s0.starts, s0.pid, s0.cache], ["stopped", 0, null, null]);
      await reg.listTools("fixture", caller);
      const s1 = reg.status("fixture", caller.agentId);
      assert.equal(s1.state, "running");
      assert.equal(s1.starts, 1);
      assert.ok(s1.pid && s1.pid > 0);
      assert.ok(s1.cache && s1.cache.toolNames.includes("echo") && s1.cache.schemaTokensEstimate > 0);
    } finally { await reg.shutdown(); }
  });

  it("idle timeout stops the server and the schema cache survives; the next call restarts it", async () => {
    const { reg, def, clock } = setup();
    try {
      reg.register(def());
      await reg.listTools("fixture", caller);
      const pid1 = reg.status("fixture", caller.agentId).pid!;
      await clock.advance(IDLE - 1);
      assert.equal(reg.status("fixture", caller.agentId).state, "running", "still running 1 ms before the idle timeout");
      await clock.advance(1);
      // The stop is asynchronous (it awaits the child's exit); wait for the state to settle.
      for (let i = 0; i < 200 && reg.status("fixture", caller.agentId).state !== "stopped"; i++) await new Promise((r) => setTimeout(r, 10));
      const stopped = reg.status("fixture", caller.agentId);
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.pid, null);
      assert.ok(await waitDead(pid1), "the idle-stopped child must be gone");
      assert.ok(stopped.cache && stopped.cache.toolNames.includes("echo"), "cache survives the idle stop");
      // listTools is answered from the cache without spawning anything.
      const tools = await reg.listTools("fixture", caller);
      assert.ok(tools.some((t) => t.name === "echo"));
      assert.equal(reg.status("fixture", caller.agentId).starts, 1);
      assert.equal(reg.status("fixture", caller.agentId).state, "stopped");
      // A call starts it again, with the cache still in place.
      const r = await reg.callTool("fixture", "echo", { text: "again" }, caller);
      assert.deepEqual(r.content, [{ type: "text", text: "echo:again" }]);
      const s = reg.status("fixture", caller.agentId);
      assert.equal(s.starts, 2);
      assert.equal(s.state, "running");
      assert.notEqual(s.pid, pid1);
    } finally { await reg.shutdown(); }
  });

  it("each use re-arms the idle timer", async () => {
    const { reg, def, clock } = setup();
    try {
      reg.register(def());
      await reg.callTool("fixture", "echo", { text: "a" }, caller);
      await clock.advance(IDLE - 1000);
      await reg.callTool("fixture", "echo", { text: "b" }, caller);
      await clock.advance(IDLE - 1000);
      assert.equal(reg.status("fixture", caller.agentId).state, "running", "second call pushed the stop out");
      assert.equal(reg.status("fixture", caller.agentId).idleStopsAt, clock.now() + 1000);
    } finally { await reg.shutdown(); }
  });

  it("a call in flight holds the idle timer; it re-arms when the call ends", async () => {
    const { reg, def, clock } = setup();
    try {
      reg.register(def({ timeouts: { connectMs: 20_000, listMs: 3_600_000, callMs: 3_600_000, closeGraceMs: 300 } }));
      await reg.listTools("fixture", caller);
      const slow = reg.callTool("fixture", "sleep", { ms: 400 }, caller);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(reg.status("fixture", caller.agentId).inFlight, 1);
      await clock.advance(IDLE * 2);
      assert.equal(reg.status("fixture", caller.agentId).state, "running", "an in-flight call must not be cut off by the idle timer");
      await slow;
      const s = reg.status("fixture", caller.agentId);
      assert.equal(s.inFlight, 0);
      assert.ok(s.idleStopsAt !== null, "re-armed after the call");
    } finally { await reg.shutdown(); }
  });

  it("concurrent first uses share one start-up", async () => {
    const { reg, def } = setup();
    try {
      reg.register(def());
      await Promise.all([reg.listTools("fixture", caller), reg.callTool("fixture", "echo", { text: "x" }, caller), reg.callTool("fixture", "echo", { text: "y" }, caller)]);
      assert.equal(reg.status("fixture", caller.agentId).starts, 1);
    } finally { await reg.shutdown(); }
  });

  it("tools/list_changed marks the cache stale and the next listing refetches", async () => {
    const { reg, def } = setup();
    try {
      reg.register(def());
      await reg.callTool("fixture", "change_tools", {}, caller);
      for (let i = 0; i < 100 && !reg.status("fixture", caller.agentId).cache?.stale; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(reg.status("fixture", caller.agentId).cache?.stale, true);
      await reg.listTools("fixture", caller);
      assert.equal(reg.status("fixture", caller.agentId).cache?.stale, false);
    } finally { await reg.shutdown(); }
  });

  it("an unknown tool is refused with unknown-tool before the server is asked", async () => {
    const { reg, def } = setup();
    try {
      reg.register(def());
      assert.equal(await codeOf(reg.callTool("fixture", "nope", {}, caller)), "unknown-tool");
    } finally { await reg.shutdown(); }
  });

  it("a crashing server is an error for that call; the next call starts a fresh one", async () => {
    const { reg, def } = setup();
    try {
      reg.register(def());
      await reg.listTools("fixture", caller);
      assert.equal(await codeOf(reg.callTool("fixture", "crash", {}, caller)), "closed");
      for (let i = 0; i < 100 && reg.status("fixture", caller.agentId).state !== "stopped"; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(reg.status("fixture", caller.agentId).state, "stopped");
      assert.equal(reg.status("fixture", caller.agentId).lastError?.code, "closed");
      const r = await reg.callTool("fixture", "echo", { text: "back" }, caller);
      assert.equal(r.isError, false);
      assert.equal(reg.status("fixture", caller.agentId).starts, 2);
    } finally { await reg.shutdown(); }
  });
});

describe("mcp registry: scope (D17)", { timeout: 120_000 }, () => {
  it("an agent-scoped server is private; another agent cannot tell it exists", async () => {
    const { reg, def } = setup();
    try {
      reg.register(def({ name: "mine", scope: { kind: "agent", agentId: "bernd" } }));
      reg.register(def({ name: "shared" }));
      assert.deepEqual(reg.list("bernd").map((s) => s.name), ["mine", "shared"]);
      assert.deepEqual(reg.list("friday").map((s) => s.name), ["shared"]);
      assert.equal(await codeOf(reg.listTools("mine", agentB)), "not-registered");
      assert.equal(await codeOf(reg.callTool("mine", "echo", { text: "x" }, agentB)), "not-registered");
      assert.throws(() => reg.status("mine", "friday"), (e: McpClientError) => e.code === "not-registered");
      assert.equal(reg.status("mine", "bernd").scope.kind, "agent");
    } finally { await reg.shutdown(); }
  });

  it("agent scope means one process per agent; installation scope shares one", async () => {
    const { reg, def } = setup();
    try {
      reg.register(def({ name: "priv", scope: { kind: "agent", agentId: "bernd" } }));
      reg.register(def({ name: "priv", scope: { kind: "agent", agentId: "friday" } }));
      reg.register(def({ name: "shared" }));
      const pid = async (n: string, c: typeof caller) => Number(((await reg.callTool(n, "pid", {}, c)).content[0] as { text: string }).text);
      const [a, b, s1, s2] = [await pid("priv", caller), await pid("priv", agentB), await pid("shared", caller), await pid("shared", agentB)];
      assert.notEqual(a, b);
      assert.equal(s1, s2);
    } finally { await reg.shutdown(); }
  });

  it("refuses duplicate names, and a name that would mean two things to an agent", async () => {
    const { reg, def } = setup();
    try {
      reg.register(def({ name: "dup" }));
      assert.throws(() => reg.register(def({ name: "dup" })), (e: McpClientError) => e.code === "invalid-config");
      assert.throws(() => reg.register(def({ name: "dup", scope: { kind: "agent", agentId: "bernd" } })), (e: McpClientError) => e.code === "invalid-config");
      reg.register(def({ name: "x", scope: { kind: "agent", agentId: "bernd" } }));
      assert.throws(() => reg.register(def({ name: "x" })), (e: McpClientError) => e.code === "invalid-config");
      reg.register(def({ name: "x", scope: { kind: "agent", agentId: "friday" } })); // same name for two different agents is fine
    } finally { await reg.shutdown(); }
  });

  it("registers nothing with an empty allowlist (fail closed)", () => {
    const { def } = setup();
    const reg = new McpRegistry({ logger: capturingLogger(), hostEnv: {} });
    assert.throws(() => reg.register(def()), (e: McpClientError) => e.code === "not-allowed");
  });

  it("shutdown stops every server and refuses later use", async () => {
    const { reg, def } = setup();
    reg.register(def({ name: "a" })); reg.register(def({ name: "b" }));
    await reg.listTools("a", caller); await reg.listTools("b", caller);
    const pids = [reg.status("a", caller.agentId).pid!, reg.status("b", caller.agentId).pid!];
    await reg.shutdown();
    for (const p of pids) assert.ok(await waitDead(p), "child survived shutdown");
    assert.equal(await codeOf(reg.callTool("a", "echo", { text: "x" }, caller)), "closed");
  });
});

describe("mcp registry: streamable http", { timeout: 60_000 }, () => {
  let http: FixtureHttp;
  after(async () => { await http?.close(); });
  it("lists and calls a remote fixture, idle-stops the session, and keeps the cache", async () => {
    http = await startFixtureHttp();
    const { reg, clock } = setup();
    try {
      reg.register({ name: "remote", transport: { type: "http", url: http.url } });
      const r = await reg.callTool("remote", "echo", { text: "over http" }, caller);
      assert.deepEqual(r.content, [{ type: "text", text: "echo:over http" }]);
      assert.equal(r.provenance.origin.system, "mcp:remote");
      assert.equal(reg.status("remote", caller.agentId).state, "running");
      await clock.advance(IDLE);
      for (let i = 0; i < 200 && reg.status("remote", caller.agentId).state !== "stopped"; i++) await new Promise((x) => setTimeout(x, 10));
      assert.equal(reg.status("remote", caller.agentId).state, "stopped");
      assert.ok(reg.status("remote", caller.agentId).cache);
    } finally { await reg.shutdown(); }
  });
});
