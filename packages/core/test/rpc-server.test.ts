import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { connect, RpcCallError, encodeLine, LineDecoder } from "@plur1bus/module-api";
import { loadFixtures } from "@plur1bus/rpc-schema";
import { createLogger } from "../src/logger.ts";
import { RpcError } from "../src/rpc/errors.ts";
import { createRpcServer, MAX_PENDING_BYTES, type RpcServer } from "../src/rpc/server.ts";

const TOKEN = "c".repeat(64);
const dir = mkdtempSync(join(tmpdir(), "p1b-rpc-"));
const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-test-${process.pid}` : join(dir, "core.sock");
const hello = () => ({ contract: "1.4.1", rpc: "1.0.0", instanceId: "inst-test", pid: process.pid });
const log = createLogger({ file: join(dir, "core.log"), level: "debug", role: "core" });
// noUncheckedIndexedAccess makes Fixtures["methods"][x] possibly undefined; these fixtures always exist.
const fx = (method: string): { params: any; result: any } => (loadFixtures().methods as any)[method];
let onCheckpointAbort: (() => void) | null = null;
let onCheckpointStart: (() => void) | null = null;
let onStateStart: (() => void) | null = null;
let releaseState: (() => void) | null = null;

describe("rpc server", () => {
  let server: RpcServer;
  before(async () => {
    server = createRpcServer({
      address, token: TOKEN, hello, logger: log, authIdleMs: 200,
      methods: {
        "core.status": async () => ({ ...fx("core.status").result, pid: process.pid, instanceId: "inst-test" }),
        "memory.recall": async (p, ctx) => { if (p.query === "throw") throw new RpcError("E_AGENT_UNKNOWN", "no such agent", { reason: "not-registered" }); if (p.query === "boom") throw new Error("kaboom"); const { joined: _j, ...rest } = fx("memory.recall").result; return { ...rest, trace: { requestId: ctx.requestId } }; },
        "core.shutdown": async () => ({ accepted: true }),
        "memory.checkpoint": (_p, ctx) => new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => { onCheckpointAbort?.(); reject(new Error("aborted")); });
          onCheckpointStart?.();
        }),
        // Held until the test calls releaseState(): a listed method whose reply drain() must wait for.
        "memory.state": () => new Promise((resolve) => { releaseState = () => resolve(fx("memory.state").result); onStateStart?.(); }),
      },
    });
    await server.listen();
  });
  after(async () => { await server.close(); await log.close(); });

  it("creates the socket 0600 in a 0700 dir (posix)", { skip: process.platform === "win32" }, () => {
    assert.equal(statSync(address).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777 & 0o077, 0);
  });

  it("refuses every method before auth, then serves after core.auth", async () => {
    await assert.rejects(connect({ address, token: "d".repeat(64) }), (e: any) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED");
    const c = await connect({ address, token: TOKEN });
    assert.deepEqual(c.hello, hello());
    const s = await c.call<any>("core.status"); assert.equal(s.process.state, "ready");
    await c.close();
  });

  it("validates params against the schema and answers E_INVALID_PARAMS with the path", async () => {
    const c = await connect({ address, token: TOKEN });
    await assert.rejects(c.call("memory.recall", { agentId: "bernd" }), (e: any) => e.error === "E_INVALID_PARAMS" && e.code === -32602 && /caller|query/.test(e.detail ?? ""));
    await assert.rejects(c.call("memory.recall", { ...fx("memory.recall").params, origin: "cron" }), (e: any) => e.error === "E_INVALID_PARAMS");
    await c.close();
  });

  it("passes RpcError through and hides internal errors as E_INTERNAL", async () => {
    const c = await connect({ address, token: TOKEN });
    const base = fx("memory.recall").params;
    await assert.rejects(c.call("memory.recall", { ...base, query: "throw" }), (e: any) => e.error === "E_AGENT_UNKNOWN" && e.reason === "not-registered");
    await assert.rejects(c.call("memory.recall", { ...base, query: "boom" }), (e: any) => e.error === "E_INTERNAL" && !/kaboom/.test(e.message));
    await c.close();
  });

  it("unknown method is E_INTERNAL/method-not-found with -32601, result is schema-validated", async () => {
    const c = await connect({ address, token: TOKEN });
    await assert.rejects(c.call("nope"), (e: any) => e.code === -32601 && e.reason === "method-not-found");
    const r = await c.call<any>("memory.recall", fx("memory.recall").params);
    assert.equal(r.trace.requestId.length > 0, true);
    await c.close();
  });

  it("subscriptions receive notify() filtered by name and agentId, and stop after unsubscribe", async () => {
    const c = await connect({ address, token: TOKEN });
    const got: unknown[] = []; c.onNotification((m, p) => got.push([m, p]));
    const { subscriptionId } = await c.call<any>("events.subscribe", { names: ["agent.activity"], agentId: "bernd" });
    server.notify("agent.activity", { agentId: "bernd", activity: { state: "recalling", since: 1 } });
    server.notify("agent.activity", { agentId: "other", activity: { state: "recalling", since: 1 } });
    server.notify("core.state", { process: { state: "ready" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(got, [["agent.activity", { agentId: "bernd", activity: { state: "recalling", since: 1 } }]]);
    assert.deepEqual(await c.call("events.unsubscribe", { subscriptionId }), { removed: true });
    server.notify("agent.activity", { agentId: "bernd", activity: { state: "idle", since: 2 } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.length, 1);
    await c.close();
  });

  it("an optIn notification reaches only subscriptions that name it", async () => {
    const all = await connect({ address, token: TOKEN }); const named = await connect({ address, token: TOKEN });
    const gotAll: unknown[] = []; all.onNotification((m, p) => gotAll.push([m, p]));
    const gotNamed: unknown[] = []; named.onNotification((m, p) => gotNamed.push([m, p]));
    await all.call("events.subscribe", {});
    await named.call("events.subscribe", { names: ["engine.event"] });
    const ev = { name: "recall.completed", agentId: "bernd", payload: { agentId: "bernd" } };
    server.notify("engine.event", ev, { optIn: true });
    server.notify("core.state", { process: { state: "ready" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(gotAll, [["core.state", { process: { state: "ready" } }]]);
    assert.deepEqual(gotNamed, [["engine.event", ev]]);
    await all.close(); await named.close();
  });

  it("an audience lets a subscription filtered to either agent receive it", async () => {
    const clients = await Promise.all(["bernd", "anna", "ghost"].map(() => connect({ address, token: TOKEN })));
    const got: string[][] = [[], [], []];
    clients.forEach((c, i) => c.onNotification((m) => got[i]!.push(m)));
    await Promise.all(["bernd", "anna", "ghost"].map((agentId, i) => clients[i]!.call("events.subscribe", { agentId })));
    server.notify("memory.proposal", { agentId: "bernd", proposalId: "p-1", status: "pending", sharerAgentId: "bernd", proposerAgentId: "anna", sharedId: "m-1" }, { audience: ["bernd", "anna"] });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(got, [["memory.proposal"], ["memory.proposal"], []]);
    await Promise.all(clients.map((c) => c.close()));
  });

  it("subscribing to a deprecated notification logs one warning per process", async () => {
    const c = await connect({ address, token: TOKEN });
    await c.call("events.subscribe", { names: ["engine.event"] });
    await c.call("events.subscribe", { names: ["engine.event", "core.state"] });
    await c.call("events.subscribe", { names: ["core.state"] });
    await c.close();
    await new Promise((r) => setTimeout(r, 50)); // let the log stream flush
    const warnings = readFileSync(join(dir, "core.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.msg === "deprecated surface used");
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.equal(warnings[0].level, "warn");
    assert.equal(warnings[0].kind, "notification"); assert.equal(warnings[0].name, "engine.event");
    assert.equal(warnings[0].since, "1.1.0"); assert.equal(warnings[0].removeAfter, "2027-03-26");
    assert.match(warnings[0].replacement, /recall\.completed/);
  });

  it("rejects core.auth params that fail schema validation and closes the connection", async () => {
    const raw = createConnection(address);
    await new Promise((r) => raw.once("connect", r));
    const dec = new LineDecoder(); const msgs: any[] = [];
    raw.on("data", (b) => msgs.push(...(dec.push(b) as any[])));
    const closed = new Promise<void>((r) => raw.once("close", () => r()));
    raw.write(encodeLine({ jsonrpc: "2.0", id: 1, method: "core.auth", params: {} }));
    await closed;
    assert.ok(msgs.some((m) => m.error?.data?.error === "E_INVALID_PARAMS"));
  });

  it("closes an unauthenticated idle connection after authIdleMs", async () => {
    const raw = createConnection(address);
    const closed = new Promise<void>((r) => raw.once("close", () => r()));
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("not closed")), 1000))]);
  });

  it("rejects a line over 4 MiB and closes the connection", async () => {
    const raw = createConnection(address);
    await new Promise((r) => raw.once("connect", r));
    const dec = new LineDecoder(); const msgs: any[] = [];
    raw.on("data", (b) => msgs.push(...(dec.push(b) as any[])));
    raw.write(encodeLine({ jsonrpc: "2.0", id: 1, method: "core.auth", params: { token: TOKEN } }));
    raw.write(Buffer.alloc(4 * 1024 * 1024 + 10, 0x7b));
    await new Promise<void>((r) => raw.once("close", () => r()));
    assert.ok(msgs.some((m) => m.error?.data?.error === "E_INVALID_PARAMS" && m.error.data.reason === "line-too-long"));
  });

  it("disconnects a subscriber whose pending writes exceed MAX_PENDING_BYTES, and the server stays responsive", async () => {
    const raw = createConnection(address);
    await new Promise((r) => raw.once("connect", r));
    raw.write(encodeLine({ jsonrpc: "2.0", id: 1, method: "core.auth", params: { token: TOKEN } }));
    await new Promise((r) => setTimeout(r, 20));
    raw.write(encodeLine({ jsonrpc: "2.0", id: 2, method: "events.subscribe", params: { names: ["agent.activity"] } }));
    await new Promise((r) => setTimeout(r, 20));
    // Stop reading: a stalled client must never grow the server's write buffer unbounded.
    // (raw.pause() calls the underlying socket's readStop(), so the client itself will not
    // notice the server-side close until it resumes reading below — exactly like a real
    // stuck consumer, which is why we assert the server-side effect first via subscriptions().)
    raw.pause();

    const blob = "x".repeat(1024 * 1024); // ~1 MiB per notification
    let sent = 0;
    // MAX_PENDING_BYTES is 16 MiB; 64 MiB of notifications must trigger a disconnect well before the loop ends.
    for (let i = 0; i < 64 && server.subscriptions().length > 0; i++) {
      server.notify("agent.activity", { agentId: "bernd", activity: { state: "recalling", since: i, blob } });
      sent++;
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(server.subscriptions().length, 0, "server should have dropped the stalled subscriber");
    // The exact crossover point depends on kernel socket-buffer sizes and flush timing, so assert
    // loosely: the loop must not have run to completion, and it must have taken roughly as many
    // ~1 MiB notifications as MAX_PENDING_BYTES implies (well under 64, well over a handful).
    assert.ok(sent < 64, `server should have disconnected before exhausting the loop (sent ${sent})`);
    assert.ok(sent >= MAX_PENDING_BYTES / (1024 * 1024) - 2, `server disconnected implausibly early (sent ${sent})`);

    // the client itself confirms the disconnection once it resumes reading
    const closed = new Promise<void>((res) => raw.once("close", () => res()));
    raw.resume();
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("client never observed the close")), 2000))]);

    // the server must remain responsive to other, well-behaved clients afterwards
    const c = await connect({ address, token: TOKEN });
    const s = await c.call<any>("core.status");
    assert.equal(s.process.state, "ready");
    await c.close();
  });

  it("aborts ctx.signal for an in-flight handler when the client disconnects", async () => {
    const c = await connect({ address, token: TOKEN });
    const aborted = new Promise<void>((res) => { onCheckpointAbort = res; });
    const callPromise = c.call("memory.checkpoint", fx("memory.checkpoint").params).catch(() => {});
    await new Promise((r) => setTimeout(r, 30)); // let the request reach the server and start the handler
    await c.close();
    await Promise.race([aborted, new Promise((_, rej) => setTimeout(() => rej(new Error("ctx.signal was not aborted")), 1000))]);
    await callPromise;
  });

  it("drain resolves drained false after budgetMs when a handler never settles", async () => {
    const c = await connect({ address, token: TOKEN });
    const started = new Promise<void>((res) => { onCheckpointStart = res; });
    const call = c.call("memory.checkpoint", fx("memory.checkpoint").params).catch(() => {});
    await started;
    const t0 = performance.now();
    const r = await server.drain({ methods: ["memory.checkpoint"], budgetMs: 200 });
    assert.deepEqual(r, { drained: false, pending: 1 });
    assert.ok(performance.now() - t0 >= 150, "drain returned before its budget");
    await c.close(); await call;
  });

  it("drain ignores methods it was not asked for", async () => {
    const c = await connect({ address, token: TOKEN });
    const started = new Promise<void>((res) => { onCheckpointStart = res; });
    const call = c.call("memory.checkpoint", fx("memory.checkpoint").params).catch(() => {});
    await started;
    // A never-settling memory.checkpoint is in flight; waiting on it would take the whole budget and answer false.
    assert.deepEqual(await server.drain({ methods: ["memory.recall", "memory.state"], budgetMs: 10_000 }), { drained: true, pending: 0 });
    await c.close(); await call;
  });

  it("drain waits until a listed dispatch has written its reply", async () => {
    const c = await connect({ address, token: TOKEN });
    const started = new Promise<void>((res) => { onStateStart = res; });
    const call = c.call<any>("memory.state", fx("memory.state").params);
    await started;
    let settled = false;
    const d = server.drain({ methods: ["memory.state"], budgetMs: 10_000 }).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(settled, false, "drain resolved while the handler was still running");
    releaseState!();
    assert.deepEqual(await d, { drained: true, pending: 0 });
    assert.equal((await call).agentId, "bernd");
    await c.close();
  });

  it("a second listen on the same address fails, and close removes the socket", { skip: process.platform === "win32" }, async () => {
    const other = createRpcServer({ address, token: TOKEN, hello, logger: log, methods: {} });
    await assert.rejects(other.listen(), /EADDRINUSE|in use/);
  });
});

describe("rpc server close", () => {
  const closeDir = mkdtempSync(join(tmpdir(), "p1b-rpc-close-"));
  const closeAddress = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-test-close-${process.pid}` : join(closeDir, "core.sock");
  const closeLog = createLogger({ file: join(closeDir, "core.log"), level: "debug", role: "core" });
  after(async () => { await closeLog.close(); });

  it("close() ends sockets so a reply written just before close is received", async () => {
    // A reply larger than the socket buffer is still partly queued in user space when close() runs: destroy() would drop
    // that tail (and the client would see "connection closed"); end() flushes it first.
    const big = "x".repeat(2 * 1024 * 1024);
    let server: RpcServer | null = null;
    server = createRpcServer({
      address: closeAddress, token: TOKEN, hello, logger: closeLog,
      methods: {
        "memory.recall": async () => {
          // setImmediate runs after the microtasks in which the server validates and writes this handler's result.
          setImmediate(() => { void server!.close(); });
          const { joined: _j, ...rest } = fx("memory.recall").result;
          return { ...rest, blocks: [{ name: "memories", text: big, droppable: true, chars: big.length }] };
        },
      },
    });
    await server.listen();
    const c = await connect({ address: closeAddress, token: TOKEN });
    const r = await c.call<any>("memory.recall", fx("memory.recall").params);
    assert.equal(r.blocks[0].text.length, big.length);
    await c.close();
    await server.close();
  });
});
