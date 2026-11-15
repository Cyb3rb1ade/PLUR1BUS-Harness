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

/** One raw connection: sends `frames` one after the other, each after the previous reply, and resolves with the replies
 *  (fewer when the server closed the connection first). */
function talk(address: string, frames: { method: string; params: Record<string, unknown> }[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const s = createConnection(address);
    const replies: any[] = []; let buf = "";
    const timer = setTimeout(() => { s.destroy(); resolve(replies); }, 3000);
    const next = () => {
      if (replies.length === frames.length) { clearTimeout(timer); s.destroy(); return resolve(replies); }
      s.write(JSON.stringify({ jsonrpc: "2.0", id: replies.length + 1, ...frames[replies.length]! }) + "\n");
    };
    s.on("data", (d) => {
      buf += String(d);
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { replies.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); next(); }
    });
    s.on("close", () => { clearTimeout(timer); resolve(replies); });
    s.on("error", reject);
    next();
  });
}

async function server(t: test.TestContext, o: { frontDoorToken?: string; engineToken?: string; apiToken?: string; authorizeClient?: (token: string) => Promise<any>; legacy?: (p: any) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "p1b-front-door-link-")); const address = rpcAddress(dir);
  const token = hex();
  const logger = createLogger({ file: join(dir, "test.log"), role: "core", level: "error" });
  const s = createRpcServer({
    address, token, logger, methods: { "core.status": async () => ({ ok: true }), ...(o.legacy ? { "legacy.account.changed": async (p: any) => { o.legacy!(p); return {}; } } : {}) } as any,
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

// P4-12 flip A2: `legacy.*` methods exist on one connection only, the front door's control link.
const notFound = (reply: any) => reply?.error?.code === -32601 && reply.error.data.error === "E_INTERNAL" && reply.error.data.reason === "method-not-found";
const changed = { method: "legacy.account.changed", params: { userId: "u1", rights: true, learning: false } };

test("flip A2: the control link is an owner link named front-door, and the only connection that reaches a legacy.* method", async (t) => {
  const link = hex(), apiToken = hex(), engineToken = hex(); const seen: any[] = [];
  const { address, token } = await server(t, { frontDoorToken: link, apiToken, engineToken, legacy: (p) => seen.push(p), authorizeClient: async (tok) => { if (tok !== "c".repeat(64)) throw new Error("no"); return { userId: "c1", kind: "person", role: "member" }; } });
  const auth = (params: Record<string, unknown>) => ({ method: "core.auth", params });
  const control = await talk(address, [auth({ token, frontDoor: { token: link, caller: "front-door" } }), changed, { method: "core.status", params: {} },
    { method: "legacy.account.changed", params: { userId: "u1", rights: true } }, { method: "legacy.unknown", params: {} }]);
  assert.equal(control[0].result.instanceId, "legacy");
  assert.deepEqual(control[1].result, {});
  assert.deepEqual(seen, [{ userId: "u1", rights: true, learning: false }]);
  assert.equal(control[2].error.data.reason, "result-schema", "the control link reaches the core's methods as before (this stub's result is not the schema's)");
  assert.equal(control[3].error.data.error, "E_INVALID_PARAMS", "closed params, checked before the handler");
  assert.ok(notFound(control[4]), "only the schema's legacy.* methods exist");

  // Every other kind of link: the method does not exist, exactly as on a core without a front door.
  const owner = await talk(address, [auth({ token, frontDoor: { token: link, caller: "owner" } }), changed]);
  assert.ok(notFound(owner[1])); assert.equal(owner[1].error.message, "method not found: legacy.account.changed");
  const api = await talk(address, [auth({ token, api: { clientId: "harness-api", token: apiToken }, frontDoor: { token: link, caller: "api" } }), changed]);
  assert.ok(api[0].result); assert.ok(api[1].error); assert.equal(api[1].result, undefined);
  const client = await talk(address, [auth({ token: "c".repeat(64), frontDoor: { token: link, caller: "client" } }), changed]);
  assert.ok(client[0].result); assert.ok(notFound(client[1]));
  const engine = await talk(address, [auth({ token: engineToken, engine: { clientId: "plur1bus-engine", token: engineToken }, frontDoor: { token: link, caller: "engine" } }), changed]);
  assert.ok(engine[0].result); assert.equal(engine[1].error.data.reason, "engine-method");
  assert.equal(seen.length, 1, "none of them reached the handler");

  // The name is the owner's alone: other credentials cannot take it.
  for (const [what, params] of Object.entries({
    api: { token, api: { clientId: "harness-api", token: apiToken } },
    engine: { token: engineToken, engine: { clientId: "plur1bus-engine", token: engineToken } },
    client: { token: "c".repeat(64) },
  })) assert.ok(refused(await handshake(address, { ...params, frontDoor: { token: link, caller: "front-door" } })), what);
  assert.ok(refused(await handshake(address, { token, frontDoor: { token: hex(), caller: "front-door" } })), "a wrong link token");
});

test("flip A2: a connection is the control link from its first handshake or never", async (t) => {
  const link = hex(); const seen: any[] = [];
  const { address, token } = await server(t, { frontDoorToken: link, legacy: (p) => seen.push(p) });
  const auth = (caller: string) => ({ method: "core.auth", params: { token, frontDoor: { token: link, caller } } });
  const promoted = await talk(address, [auth("owner"), auth("front-door"), changed]);
  assert.ok(promoted[0].result); assert.equal(promoted[1].error.data.reason, "front-door-link"); assert.equal(promoted.length, 2, "closed");
  const demoted = await talk(address, [auth("front-door"), auth("owner"), changed]);
  assert.ok(demoted[0].result); assert.equal(demoted[1].error.data.reason, "front-door-link"); assert.equal(demoted.length, 2, "closed");
  const again = await talk(address, [auth("front-door"), auth("front-door"), changed]);
  assert.ok(again[1].result, "the same handshake again is the same connection"); assert.deepEqual(again[2].result, {});
  assert.equal(seen.length, 1);
});

test("flip A2: without a front door there is no legacy.* method and no control link", async (t) => {
  const seen: any[] = [];
  const { address, token } = await server(t, { legacy: (p) => seen.push(p) });
  const plain = await talk(address, [{ method: "core.auth", params: { token } }, changed]);
  assert.ok(plain[0].result); assert.ok(notFound(plain[1]));
  assert.ok(refused(await handshake(address, { token, frontDoor: { token: hex(), caller: "front-door" } })));
  assert.equal(seen.length, 0);
});
