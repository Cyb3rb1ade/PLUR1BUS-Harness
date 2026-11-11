// P4-10 seam: the legacy core behind the Rust front door accepts a handshake only as a front-door link (`core.auth.frontDoor`
// with run/core-legacy.token and the caller kind the same params prove), and every other server refuses a link outright.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcServer } from "../src/rpc-server.ts";
import { createLogger } from "../src/logger.ts";
import { rpcAddress } from "./helpers/endpoint.ts";

const hex = () => randomBytes(32).toString("hex");

/** One raw connection: sends `msg`, resolves with the reply and whether the server then closed the connection. */
function handshake(address: string, params: Record<string, unknown>): Promise<{ reply: any; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const s = createConnection(address);
    let buf = ""; let reply: any;
    const timer = setTimeout(() => { s.destroy(); resolve({ reply, closed: false }); }, 1500);
    s.on("data", (d) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl >= 0 && reply === undefined) {
        reply = JSON.parse(buf.slice(0, nl));
        // An accepted handshake leaves the connection open: probe that a second request is still answered.
        if (reply.result) s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "core.status", params: {} }) + "\n");
      } else if (reply?.result && buf.split("\n").length > 2) { clearTimeout(timer); s.destroy(); resolve({ reply, closed: false }); }
    });
    s.on("close", () => { clearTimeout(timer); resolve({ reply, closed: true }); });
    s.on("error", reject);
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "core.auth", params }) + "\n");
  });
}

async function server(t: test.TestContext, o: { frontDoorToken?: string; engineToken?: string; apiToken?: string; authorizeClient?: (token: string) => Promise<any> }) {
  const dir = mkdtempSync(join(tmpdir(), "p1b-front-door-link-")); const address = rpcAddress(dir);
  const token = hex();
  const logger = createLogger({ file: join(dir, "test.log"), role: "core", level: "error" });
  const s = createRpcServer({
    address, token, logger, methods: { "core.status": async () => ({ ok: true }) } as any,
    hello: () => ({ contract: "1.0.0", rpc: "1.25.0", instanceId: "legacy", pid: process.pid }),
    ...(o.frontDoorToken ? { frontDoorToken: o.frontDoorToken } : {}),
    ...(o.apiToken ? { apiToken: o.apiToken } : {}),
    ...(o.engineToken ? { engineToken: () => o.engineToken } : {}),
    ...(o.authorizeClient ? { authorizeClient: o.authorizeClient } : {}),
  });
  await s.listen();
  t.after(async () => { await s.close(); await logger.close(); rmSync(dir, { recursive: true, force: true }); });
  return { address, token, dir };
}

const refused = (r: { reply: any; closed: boolean }) => r.reply?.error?.data?.error === "E_UNAUTHORIZED" && r.reply.error.data.reason === "front-door-link" && r.closed;

test("a server not behind a front door refuses a front-door link and closes the connection", async (t) => {
  const { address, token } = await server(t, {});
  assert.ok(refused(await handshake(address, { token, frontDoor: { token: hex(), caller: "owner" } })));
  const plain = await handshake(address, { token });
  assert.equal(plain.reply.result.instanceId, "legacy", "an ordinary handshake still works");
});

test("behind the front door: no link, a wrong link token or a wrong caller kind is refused; the right link is accepted", async (t) => {
  const link = hex(), apiToken = hex(), engineToken = hex();
  const { address, token } = await server(t, { frontDoorToken: link, apiToken, engineToken, authorizeClient: async (tok) => { if (tok !== "c".repeat(64)) throw new Error("no"); return { userId: "c1", kind: "person", role: "member" }; } });
  assert.ok(refused(await handshake(address, { token })), "a direct owner without the link");
  assert.ok(refused(await handshake(address, { token, frontDoor: { token: hex(), caller: "owner" } })), "a wrong link token");
  assert.ok(refused(await handshake(address, { token, frontDoor: { token: link.slice(0, 63) + (link[63] === "0" ? "1" : "0"), caller: "owner" } })), "one hex digit off");
  const owner = await handshake(address, { token, frontDoor: { token: link, caller: "owner" } });
  assert.equal(owner.reply.result.instanceId, "legacy"); assert.equal(owner.closed, false);
  // The front door names the kind; the credentials must prove the same kind here.
  const api = { clientId: "harness-api", token: apiToken };
  assert.ok(refused(await handshake(address, { token, api, frontDoor: { token: link, caller: "owner" } })), "api credentials named owner");
  assert.ok((await handshake(address, { token, api, frontDoor: { token: link, caller: "api" } })).reply.result, "api");
  const engine = { token: engineToken, engine: { clientId: "plur1bus-engine", token: engineToken } };
  assert.ok(refused(await handshake(address, { ...engine, frontDoor: { token: link, caller: "owner" } })), "engine credentials named owner");
  assert.ok((await handshake(address, { ...engine, frontDoor: { token: link, caller: "engine" } })).reply.result, "engine");
  assert.ok(refused(await handshake(address, { token: "c".repeat(64), frontDoor: { token: link, caller: "owner" } })), "a scoped client named owner");
  assert.ok((await handshake(address, { token: "c".repeat(64), frontDoor: { token: link, caller: "client" } })).reply.result, "client");
  // The link proves only that the front door forwarded the call: a bad client credential is still refused here.
  const bad = await handshake(address, { token: hex(), frontDoor: { token: link, caller: "client" } });
  assert.equal(bad.reply.error.data.reason, "client-token"); assert.ok(bad.closed);
});
