import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine } from "../src/framing.ts";
import { RpcCallError, connect } from "../src/client.ts";

const TOKEN = "a".repeat(64);
function address(): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-test-${process.pid}-${Math.random().toString(36).slice(2)}` : join(mkdtempSync(join(tmpdir(), "p1b-client-")), "core.sock");
}

/** Minimal fake core: auth, echo, one notification, slow method. */
function fakeCore(addr: string): Promise<any> {
  let liveConnections = 0;
  const server = createServer((sock: Socket) => {
    liveConnections++;
    const dec = new LineDecoder(); let authed = false;
    sock.on("data", (chunk) => {
      for (const msg of dec.push(chunk) as any[]) {
        const reply = (result: unknown) => sock.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result }));
        const fail = (code: number, error: string, reason?: string) => sock.write(encodeLine({ jsonrpc: "2.0", id: msg.id, error: { code, message: error, data: { error, reason } } }));
        if (msg.method === "core.auth") { authed = msg.params?.token === TOKEN; return authed ? reply({ contract: "1.4.1", rpc: "1.0.0", instanceId: "i", pid: 1 }) : fail(-32000, "E_UNAUTHORIZED", "bad-token"); }
        if (!authed) return fail(-32000, "E_UNAUTHORIZED", "auth-required");
        if (msg.method === "echo") return reply(msg.params);
        if (msg.method === "notify") { sock.write(encodeLine({ jsonrpc: "2.0", method: "agent.activity", params: { agentId: "a", activity: { state: "idle", since: 1 } } })); return reply({}); }
        if (msg.method === "slow") return setTimeout(() => reply({}), 500);
        fail(-32601, "E_INTERNAL", "method-not-found");
      }
    });
    sock.on("close", () => { liveConnections--; });
  });
  return new Promise<any>((res) => server.listen(addr, () => res(Object.assign(server, { getLiveConnections: () => liveConnections }))));
}

describe("client", () => {
  const addr = address();
  let server: any;
  after(() => server?.close());

  it("authenticates on connect and exposes hello", async () => {
    server = await fakeCore(addr);
    const c = await connect({ address: addr, token: TOKEN });
    assert.deepEqual(c.hello, { contract: "1.4.1", rpc: "1.0.0", instanceId: "i", pid: 1 });
    assert.deepEqual(await c.call("echo", { x: 1 }), { x: 1 });
    await c.close();
  });

  it("maps a JSON-RPC error to RpcCallError with the closed code", async () => {
    const c = await connect({ address: addr, token: TOKEN });
    await assert.rejects(c.call("nope"), (e: any) => e instanceof RpcCallError && e.error === "E_INTERNAL" && e.reason === "method-not-found");
    await c.close();
  });

  it("rejects a bad token at connect", async () => {
    await assert.rejects(connect({ address: addr, token: "b".repeat(64) }), (e: any) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED");
  });

  it("delivers notifications and times out a slow call", async () => {
    const c = await connect({ address: addr, token: TOKEN, callTimeoutMs: 100 });
    const seen: unknown[] = []; c.onNotification((m, p) => seen.push([m, p]));
    await c.call("notify");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, [["agent.activity", { agentId: "a", activity: { state: "idle", since: 1 } }]]);
    await assert.rejects(c.call("slow"), (e: any) => e instanceof RpcCallError && e.error === "E_CORE_UNAVAILABLE" && e.reason === "call-timeout");
    await c.close();
  });

  it("connect to a missing socket fails fast with E_CORE_UNAVAILABLE", async () => {
    const t0 = performance.now();
    await assert.rejects(connect({ address: address(), token: TOKEN, connectTimeoutMs: 300 }), (e: any) => e instanceof RpcCallError && e.error === "E_CORE_UNAVAILABLE");
    assert.ok(performance.now() - t0 < 300, "fails before the timeout on ENOENT");
  });

  it("cleans up the socket when auth handshake rejects", async () => {
    // Allow any pending close events from previous tests to settle
    await new Promise((r) => setTimeout(r, 50));
    const liveAtStart = (server as any).getLiveConnections();
    await assert.rejects(connect({ address: addr, token: "b".repeat(64) }), (e: any) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED");
    await new Promise((r) => setTimeout(r, 200));
    const liveAtEnd = (server as any).getLiveConnections();
    assert.strictEqual(liveAtEnd, liveAtStart, "socket was not cleaned up after failed auth");
  });
});
