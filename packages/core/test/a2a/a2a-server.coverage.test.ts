import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import net from "node:net";
import { createA2aServer, loopbackAddress, type A2aServer, type A2aServerOptions } from "../../src/a2a/server.ts";
import type { A2aTurnPort } from "../../src/a2a/turn-port.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { AGENTS, KEY_A, peers } from "./helpers.ts";

const open: A2aServer[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });
const base = (extra: Partial<A2aServerOptions> = {}): A2aServerOptions => ({
  peers: peers(), agents: (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined), provider: () => new FakeChatProvider(), ...extra,
});
async function start(extra: Partial<A2aServerOptions> = {}) {
  const s = createA2aServer(base(extra));
  open.push(s);
  return { s, ...(await s.listen()) };
}
const auth = { authorization: `Bearer ${KEY_A}` };
const rpcBody = (method: string, params: unknown, id: unknown = 1): string => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/a2a/bernd/`, { method: "POST", headers: { ...auth, "content-type": "application/json", ...headers }, body });
const msg = (text: string, extra: Record<string, unknown> = {}) => ({ message: { role: "user", messageId: `m-${text}-${Math.random()}`, parts: [{ kind: "text", text }] }, ...extra });

/** Sends raw bytes and returns everything the server wrote until it closed the connection. */
function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let out = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => { out += d; });
    sock.on("error", reject);
    sock.on("close", () => resolve(out));
    sock.on("connect", () => sock.write(payload));
  });
}

describe("loopbackAddress", () => {
  const ok: [string, string][] = [["localhost", "127.0.0.1"], ["127.0.0.1", "127.0.0.1"], ["127.1.2.3", "127.1.2.3"], ["127.255.255.254", "127.255.255.254"], ["::1", "::1"]];
  for (const [input, expected] of ok) it(`accepts ${input}`, () => assert.equal(loopbackAddress(input), expected));
  const refused = ["0.0.0.0", "::", "192.168.0.1", "10.0.0.1", "8.8.8.8", "128.0.0.1", "126.0.0.1", "example.com", "LOCALHOST", "localhost.", "127.0.0.1.example.com", "::2", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "[::1]", "127", "127.0.0", "", " "];
  for (const input of refused) {
    it(`refuses ${JSON.stringify(input)}`, () => {
      assert.throws(() => loopbackAddress(input), (e: unknown) => e instanceof Error && /loopback only/.test(e.message) && e.message.includes(JSON.stringify(input)));
    });
  }
});

describe("createA2aServer lifecycle", () => {
  it("handler is undefined before listen and defined after; server is a node http.Server with a connection cap", async () => {
    const s = createA2aServer(base());
    open.push(s);
    assert.equal(s.handler, undefined);
    assert.equal(s.server.maxConnections, 64);
    const addr = await s.listen();
    assert.ok(s.handler);
    assert.equal(addr.host, "127.0.0.1"); assert.ok(addr.port > 0); assert.equal(addr.url, `http://127.0.0.1:${addr.port}`);
  });
  it("before listen, closing is harmless", async () => {
    const s = createA2aServer(base());
    await s.close();
  });
  it("close() stops the listener and drops open connections", async () => {
    const s = createA2aServer(base());
    const { port } = await s.listen();
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => sock.on("connect", () => r()));
    const closed = new Promise<void>((r) => sock.on("close", () => r()));
    sock.on("error", () => {});
    await s.close();
    await closed;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/a2a/bernd/.well-known/agent-card.json`, { headers: auth }));
  });
  it("listen rejects when the port is taken", async () => {
    const first = await start();
    const second = createA2aServer(base({ port: first.port }));
    open.push(second);
    await assert.rejects(second.listen(), (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE");
  });
  it("host 'localhost' binds 127.0.0.1", async () => {
    const { host } = await start({ host: "localhost" });
    assert.equal(host, "127.0.0.1");
  });
  it("binds IPv6 loopback when available and accepts the bracketed Host", async (t) => {
    const s = createA2aServer(base({ host: "::1" }));
    open.push(s);
    let addr: Awaited<ReturnType<A2aServer["listen"]>>;
    try { addr = await s.listen(); } catch (e) { t.skip(`IPv6 loopback not available: ${(e as Error).message}`); return; }
    assert.equal(addr.host, "::1"); assert.equal(addr.url, `http://[::1]:${addr.port}`);
    const r = await fetch(`${addr.url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).url, `${addr.url}/a2a/bernd/`);
  });
  it("a non-loopback host is refused at construction", () => {
    assert.throws(() => createA2aServer(base({ host: "10.1.1.1" })), /loopback only/);
  });
  it("advertisedBaseUrl overrides the card base; the default is the bound address", async () => {
    const custom = await start({ advertisedBaseUrl: "https://agents.example.test" });
    const c1 = await (await fetch(`${custom.url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth })).json();
    assert.equal(c1.url, "https://agents.example.test/a2a/bernd/");
    const dflt = await start();
    const c2 = await (await fetch(`${dflt.url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth })).json();
    assert.equal(c2.url, `${dflt.url}/a2a/bernd/`);
  });
  it("host/port/advertisedBaseUrl are not forwarded to the handler options", async () => {
    const { s } = await start({ limits: { maxParts: 3 } });
    assert.equal(s.handler!.limits.maxParts, 3);
  });
});

describe("Host header and request target guards", () => {
  const cardPath = "/a2a/bernd/.well-known/agent-card.json";
  const hostStatus = (port: number, host: string | undefined) => new Promise<number>((res, rej) => {
    const q = request({ host: "127.0.0.1", port, path: cardPath, headers: { ...auth, ...(host === undefined ? {} : { host }) }, setHost: false }, (r) => { r.resume(); res(r.statusCode ?? 0); });
    q.on("error", rej); q.end();
  });
  it("accepts 127.0.0.1, localhost and [::1] with the bound port (case-insensitive)", async () => {
    const { port } = await start();
    for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) assert.equal(await hostStatus(port, h), 200, h);
  });
  it("refuses other hosts, wrong ports and a missing port with 421", async () => {
    const { port } = await start();
    for (const h of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", "localhost", `127.0.0.2:${port}`, `0.0.0.0:${port}`, `localhost.evil.example:${port}`]) assert.equal(await hostStatus(port, h), 421, h);
  });
  it("421 carries a misdirected JSON body", async () => {
    const { port } = await start();
    const raw = await rawExchange(port, `GET ${cardPath} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
    assert.match(raw, /^HTTP\/1\.1 421 /); assert.ok(raw.endsWith('{"error":"misdirected"}'));
  });
  it("a request without a Host header (HTTP/1.0) is 421", async () => {
    const { port } = await start();
    const raw = await rawExchange(port, `GET ${cardPath} HTTP/1.0\r\n\r\n`);
    assert.match(raw, /^HTTP\/1\.[01] 421 /);
  });
  it("a request target that is not origin-form (OPTIONS *) is 421", async () => {
    const { port } = await start();
    const raw = await rawExchange(port, `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.match(raw, /^HTTP\/1\.1 421 /);
  });
  it("an absolute-form target is 421", async () => {
    const { port } = await start();
    const raw = await rawExchange(port, `GET http://127.0.0.1:${port}${cardPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.match(raw, /^HTTP\/1\.1 421 /);
  });
});

describe("request mapping", () => {
  it("strips the query string from the path", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/a2a/bernd/.well-known/agent-card.json?x=1&y=2`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${url}/a2a/bernd/?a=b`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: rpcBody("tasks/get", { id: "x" }) })).status, 200);
  });
  it("responses carry Content-Length and the handler's security headers", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth });
    const text = await r.text();
    assert.equal(r.headers.get("content-length"), String(Buffer.byteLength(text)));
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
  it("Content-Length counts bytes, not characters (non-ASCII names)", async () => {
    const { url } = await start({ agents: (id) => (id === "bernd" ? { optIn: true, displayName: "Bärbel 🌍 日本語" } : undefined) });
    const r = await fetch(`${url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth });
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(r.headers.get("content-length"), String(buf.length));
    assert.equal(JSON.parse(buf.toString("utf8")).name, "Bärbel 🌍 日本語");
  });
  it("repeated header lines are joined; array-valued headers (set-cookie) do not break the request", async () => {
    const { port } = await start();
    const status = await new Promise<number>((res, rej) => {
      const q = request({ host: "127.0.0.1", port, path: "/a2a/bernd/.well-known/agent-card.json", headers: { ...auth, "set-cookie": ["a=1", "b=2"], "x-dup": ["one", "two"] } }, (r) => { r.resume(); res(r.statusCode ?? 0); });
      q.on("error", rej); q.end();
    });
    assert.equal(status, 200);
  });
  it("methods are passed through: GET on the rpc route is 405 over the wire", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/a2a/bernd/`, { headers: auth });
    assert.equal(r.status, 405); assert.equal(r.headers.get("allow"), "POST");
  });
  it("a JSON-RPC error body is delivered as 200 with the error object", async () => {
    const { url } = await start();
    const r = await post(url, rpcBody("tasks/get", { id: "missing" }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).error.code, -32001);
  });
  it("a body arriving in several chunks is reassembled", async () => {
    const { port } = await start();
    const body = rpcBody("message/send", msg("chunky", { configuration: { blocking: true } }));
    const status = await new Promise<{ code: number; json: any }>((res, rej) => {
      const q = request({ host: "127.0.0.1", port, method: "POST", path: "/a2a/bernd/", headers: { ...auth, "content-type": "application/json" } }, (r) => {
        const cs: Buffer[] = []; r.on("data", (c: Buffer) => cs.push(c)); r.on("end", () => res({ code: r.statusCode ?? 0, json: JSON.parse(Buffer.concat(cs).toString("utf8")) }));
      });
      q.on("error", rej);
      q.write(body.slice(0, 10)); setImmediate(() => { q.write(body.slice(10, 30)); setImmediate(() => q.end(body.slice(30))); });
    });
    assert.equal(status.code, 200);
    assert.equal(status.json.result.artifacts[0].parts[0].text, "echo[bernd]: chunky");
  });
  it("a declared oversized body is 413 and the connection is closed", async () => {
    const { url } = await start({ limits: { maxBodyBytes: 128 } });
    const r = await post(url, rpcBody("tasks/get", { id: "x".repeat(500) }));
    assert.equal(r.status, 413); assert.equal(r.headers.get("connection"), "close");
  });
  it("a client that aborts the body mid-way gets no answer and the server keeps serving", async () => {
    const { port, url } = await start();
    await new Promise<void>((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.on("error", () => {});
      sock.on("close", () => resolve());
      sock.on("connect", () => {
        sock.write(`POST /a2a/bernd/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${KEY_A}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"jsonrpc":`);
        setImmediate(() => sock.destroy());
      });
    });
    const ok = await fetch(`${url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth });
    assert.equal(ok.status, 200);
  });
  it("an unexpected handler failure becomes 500 internal, never a crash", async () => {
    const { url } = await start({ agents: () => { throw new Error("agent source exploded"); } });
    const r = await post(url, rpcBody("tasks/get", { id: "x" }));
    assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: "internal" });
    assert.equal(r.headers.get("content-type"), "application/json");
    const again = await fetch(`${url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth });
    assert.equal(again.status, 500);
  });
});

describe("streaming over HTTP", () => {
  const parseSse = (text: string): any[] => text.split("\n\n").filter((c) => c.startsWith("data: ")).map((c) => JSON.parse(c.slice(6)));
  it("message/stream is chunked text/event-stream (no Content-Length) ending in a final status", async () => {
    const { url } = await start();
    const r = await post(url, rpcBody("message/stream", msg("stream me")));
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /^text\/event-stream/);
    assert.equal(r.headers.get("content-length"), null);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const events = parseSse(await r.text());
    assert.equal(events[0].result.kind, "task");
    assert.equal(events.at(-1).result.status.state, "completed"); assert.equal(events.at(-1).result.final, true);
    const text = events.filter((e) => e.result.kind === "artifact-update").map((e) => e.result.artifact.parts[0].text).join("");
    assert.equal(text, "echo[bernd]: stream me");
  });
  it("tasks/resubscribe over HTTP on a finished task yields one final event", async () => {
    const { url } = await start();
    const sent = await (await post(url, rpcBody("message/send", msg("done", { configuration: { blocking: true } })))).json();
    const r = await post(url, rpcBody("tasks/resubscribe", { id: sent.result.id }));
    const events = parseSse(await r.text());
    assert.equal(events.length, 1); assert.equal(events[0].result.final, true);
  });
  it("a stream that fails after the headers were sent is ended cleanly (unknown task)", async () => {
    const { url } = await start();
    const r = await post(url, rpcBody("tasks/resubscribe", { id: "nope" }));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "");
    const ok = await fetch(`${url}/a2a/bernd/.well-known/agent-card.json`, { headers: auth });
    assert.equal(ok.status, 200);
  });
  it("a large stream honours backpressure (drain) and arrives complete", async () => {
    const big = "x".repeat(600_000);
    const turns: A2aTurnPort = {
      available: () => true, ensureSession: (a) => ({ sessionId: a.contextId }), cancel: () => false,
      run: async function* () { yield { type: "delta", text: big }; yield { type: "delta", text: big }; },
    };
    const { url } = await start({ turns });
    const r = await post(url, rpcBody("message/stream", msg("big")));
    const events = parseSse(await r.text());
    const total = events.filter((e) => e.result.kind === "artifact-update").map((e) => e.result.artifact.parts[0].text.length).reduce((a, b) => a + b, 0);
    assert.equal(total, 1_200_000);
    assert.equal(events.at(-1).result.status.state, "completed");
  });
  it("a client that disconnects mid-stream does not cancel the task", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const turns: A2aTurnPort = {
      available: () => true, ensureSession: (a) => ({ sessionId: a.contextId }), cancel: () => false,
      run: async function* () { yield { type: "delta", text: "a" }; await gate; yield { type: "delta", text: "b" }; },
    };
    const { s, url, port } = await start({ turns });
    const ctrl = new AbortController();
    const r = await fetch(`${url}/a2a/bernd/`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: rpcBody("message/stream", msg("x")), signal: ctrl.signal });
    const reader = r.body!.getReader();
    const first = await reader.read();
    const taskId = JSON.parse(Buffer.from(first.value!).toString("utf8").slice(6)).result.id as string;
    ctrl.abort();
    await reader.cancel().catch(() => {});
    release();
    await s.handler!.tasks.settled(taskId);
    const got = await post(url, rpcBody("tasks/get", { id: taskId }));
    assert.equal((await got.json()).result.status.state, "completed");
    assert.ok(port > 0);
  });
});
