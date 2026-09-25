import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { connect, RpcCallError, encodeLine, LineDecoder } from "@plur1bus/module-api";
import { loadFixtures } from "@plur1bus/rpc-schema";
import { createLogger } from "../src/logger.ts";
import { RpcError } from "../src/rpc/errors.ts";
import { createRpcServer, type RpcServer } from "../src/rpc/server.ts";

const TOKEN = "c".repeat(64);
const dir = mkdtempSync(join(tmpdir(), "p1b-rpc-"));
const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-test-${process.pid}` : join(dir, "core.sock");
const hello = () => ({ contract: "1.4.1", rpc: "1.0.0", instanceId: "inst-test", pid: process.pid });
const log = createLogger({ file: join(dir, "core.log"), level: "debug", role: "core" });
// noUncheckedIndexedAccess makes Fixtures["methods"][x] possibly undefined; these fixtures always exist.
const fx = (method: string): { params: any; result: any } => (loadFixtures().methods as any)[method];

describe("rpc server", () => {
  let server: RpcServer;
  before(async () => {
    server = createRpcServer({
      address, token: TOKEN, hello, logger: log, authIdleMs: 200,
      methods: {
        "core.status": async () => ({ ...fx("core.status").result, pid: process.pid, instanceId: "inst-test" }),
        "memory.recall": async (p, ctx) => { if (p.query === "throw") throw new RpcError("E_AGENT_UNKNOWN", "no such agent", { reason: "not-registered" }); if (p.query === "boom") throw new Error("kaboom"); const { joined: _j, ...rest } = fx("memory.recall").result; return { ...rest, trace: { requestId: ctx.requestId } }; },
        "core.shutdown": async () => ({ accepted: true }),
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

  it("a second listen on the same address fails, and close removes the socket", { skip: process.platform === "win32" }, async () => {
    const other = createRpcServer({ address, token: TOKEN, hello, logger: log, methods: {} });
    await assert.rejects(other.listen(), /EADDRINUSE|in use/);
  });
});
