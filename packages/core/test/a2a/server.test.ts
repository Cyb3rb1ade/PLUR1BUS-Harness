import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createA2aServer, loopbackAddress, type A2aServer } from "../../src/a2a/server.ts";
import { validateAgentCard } from "../../src/a2a/card.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { AGENTS, KEY_A, peers } from "./helpers.ts";

const open: A2aServer[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });
async function start(extra: Partial<Parameters<typeof createA2aServer>[0]> = {}) {
  const s = createA2aServer({ peers: peers(), agents: (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined), provider: () => new FakeChatProvider(), ...extra });
  open.push(s);
  return { s, ...(await s.listen()) };
}
const auth = { authorization: `Bearer ${KEY_A}` };

describe("a2a loopback server", () => {
  it("refuses any non-loopback bind address", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com", "10.0.0.1", ""]) assert.throws(() => loopbackAddress(h), /loopback only/);
    assert.equal(loopbackAddress("localhost"), "127.0.0.1"); assert.equal(loopbackAddress("::1"), "::1"); assert.equal(loopbackAddress("127.0.0.2"), "127.0.0.2");
    assert.throws(() => createA2aServer({ peers: [], agents: () => undefined, provider: () => null, host: "0.0.0.0" }), /loopback only/);
  });
  it("serves the card and a full task round trip over real HTTP, advertising the bound address", async () => {
    const { url } = await start();
    const card = await (await fetch(`${url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth })).json();
    assert.deepEqual(validateAgentCard(card), []);
    assert.equal(card.url, `${url}/a2a/bernd/`);
    const res = await fetch(`${url}/a2a/bernd/`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", parts: [{ kind: "text", text: "ping" }] }, configuration: { blocking: true } } }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const j = await res.json();
    assert.equal(j.result.status.state, "completed");
    assert.equal(j.result.artifacts[0].parts[0].text, "echo[bernd]: ping");
  });
  it("unauthenticated requests get 401 over the wire", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/a2a/bernd/.well-known/agent-card.json`);
    assert.equal(r.status, 401); assert.equal(r.headers.get("www-authenticate"), "Bearer");
  });
  it("a foreign Host header is refused (DNS rebinding)", async () => {
    const { port } = await start();
    const status = await new Promise<number>((res, rej) => {
      const q = request({ host: "127.0.0.1", port, path: "/a2a/bernd/.well-known/agent-card.json", headers: { ...auth, host: "evil.example" } }, (r) => { r.resume(); res(r.statusCode ?? 0); });
      q.on("error", rej); q.end();
    });
    assert.equal(status, 421);
  });
  it("an oversized streamed body is cut off with 413", async () => {
    const { port } = await start({ limits: { maxBodyBytes: 256 } });
    const status = await new Promise<number>((res, rej) => {
      const q = request({ host: "127.0.0.1", port, method: "POST", path: "/a2a/bernd/", headers: { ...auth, "content-type": "application/json", "transfer-encoding": "chunked" } }, (r) => { r.resume(); res(r.statusCode ?? 0); });
      q.on("error", rej); q.write("x".repeat(1024)); q.end();
    });
    assert.equal(status, 413);
  });
  it("nothing outside /a2a/<agent>/ is served", async () => {
    const { url } = await start();
    for (const p of ["/", "/.well-known/agent-card.json", "/a2a/", "/a2a/bernd", "/a2a/bernd/x", "/a2a/../etc"]) assert.equal((await fetch(`${url}${p}`, { headers: auth })).status, 404, p);
  });
});
