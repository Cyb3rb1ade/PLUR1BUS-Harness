import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { RPC_VERSION, loadFixtures, validateResult } from "@plur1bus/rpc-schema";
import { connect, RpcCallError } from "../src/client.ts";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import { LineDecoder, encodeLine } from "../src/framing.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const TOKEN = "d".repeat(64);
const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-ctl-test-${process.pid}` : join(tempDir("p1b-ctl-"), "module-fixture.sock");
const status = (loadFixtures().methods as any)["module.status"].result;
/** Windows: `connect` needs the pid expected to serve the pipe, and the hello below names this process. */
const asPid: { expectedServerPid?: number } = process.platform === "win32" ? { expectedServerPid: process.pid } : {};
const hello = () => ({ rpc: RPC_VERSION, instanceId: "mod-test", pid: process.pid, module: { name: "fixture", version: "0.1.0", apiVersion: "1" } });

/** A raw connection: send lines, read replies, see the close. */
function raw(): Promise<{ sock: Socket; send(m: unknown): void; next(): Promise<any>; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(address);
    const dec = new LineDecoder(); const queue: any[] = []; const waiters: ((m: any) => void)[] = [];
    sock.on("data", (c) => { for (const m of dec.push(c)) { const w = waiters.shift(); if (w) w(m); else queue.push(m); } });
    const closed = new Promise<void>((r) => sock.once("close", () => r()));
    sock.once("error", reject);
    sock.once("connect", () => resolve({
      sock, closed,
      send: (m) => sock.write(encodeLine(m)),
      next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    }));
  });
}

describe("module control server", () => {
  let server: ControlServer;
  const closedConnections: string[] = [];
  before(async () => {
    server = createControlServer({
      address, token: TOKEN, hello, authIdleMs: 300,
      handlers: { "module.status": async () => status },
      onConnectionClosed: (id) => closedConnections.push(id),
    });
    await server.listen();
  });
  after(async () => { await server.close(); });

  it("module.auth answers the hello with a module-endpoint client", async () => {
    const c = await connect({ address, token: TOKEN, endpoint: "module", ...asPid });
    assert.equal(c.hello.module?.name, "fixture");
    const s = await c.call("module.status", {});
    assert.deepEqual(validateResult("module.status", s), { ok: true });
    await c.close();
  });

  it("a request before module.auth is E_UNAUTHORIZED auth-required", async () => {
    const r = await raw();
    r.send({ jsonrpc: "2.0", id: 1, method: "module.status", params: {} });
    const m = await r.next();
    assert.equal(m.error.data.error, "E_UNAUTHORIZED");
    assert.equal(m.error.data.reason, "auth-required");
    r.sock.destroy();
  });

  it("a wrong token closes the connection", async () => {
    await assert.rejects(connect({ address, token: "e".repeat(64), endpoint: "module", ...asPid }), (e: unknown) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED" && e.reason === "bad-token");
    const r = await raw();
    r.send({ jsonrpc: "2.0", id: 1, method: "module.auth", params: { token: "e".repeat(64) } });
    assert.equal((await r.next()).error.data.reason, "bad-token");
    await r.closed; // the server ends the connection after the refusal
  });

  it("unknown params are E_INVALID_PARAMS", async () => {
    const c = await connect({ address, token: TOKEN, endpoint: "module", ...asPid });
    await assert.rejects(c.call("module.status", { verbose: true }), (e: unknown) => e instanceof RpcCallError && e.error === "E_INVALID_PARAMS");
    await c.close();
  });

  it("a core method is not served on a module endpoint", async () => {
    const c = await connect({ address, token: TOKEN, endpoint: "module", ...asPid });
    await assert.rejects(c.call("core.status", {}), (e: unknown) => e instanceof RpcCallError && e.reason === "method-not-found");
    await assert.rejects(connect({ address, token: TOKEN, endpoint: "core", ...asPid }), (e: unknown) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED" && e.reason === "auth-required");
    await c.close();
  });

  it("an unauthenticated connection closes after authIdleMs", async () => {
    const before = closedConnections.length;
    const r = await raw();
    const t0 = performance.now();
    await r.closed;
    const waited = performance.now() - t0;
    assert.ok(waited >= 250 && waited < 5000, `closed after ${Math.round(waited)} ms`);
    // onConnectionClosed runs after the socket's close; give it the same tick.
    await new Promise((res) => setImmediate(res));
    assert.ok(closedConnections.length > before, "onConnectionClosed was called");
  });
});
