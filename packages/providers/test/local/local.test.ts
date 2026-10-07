import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { after, describe, it } from "node:test";
import { createLocalChatAdapter, discoverLocalEndpoints, isLoopbackHost, isLoopbackUrl, NO_AUTH, probeEndpoint } from "../../src/local/index.ts";

type H = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
async function serve(h: H): Promise<{ origin: string; hits: IncomingMessage[] }> {
  const hits: IncomingMessage[] = [];
  const s = createServer((req, res) => { hits.push(req); h(req, res); });
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return { origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`, hits };
}
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const ollama: H = (req, res) => req.url === "/api/tags" ? json(res, { models: [{ name: "llama3:8b" }, { name: "qwen2.5:7b" }] }) : json(res, {}, 404);
const lmstudio: H = (req, res) => req.url === "/v1/models" ? json(res, { object: "list", data: [{ id: "qwen/qwen3-4b" }] }) : json(res, {}, 404);

async function deadOrigin(): Promise<string> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}

describe("loopback guard", () => {
  it("accepts loopback only", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.8.9.10", "::1", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ["0.0.0.0", "10.0.0.1", "192.168.1.5", "128.0.0.1", "127.0.0.256", "example.com", "127.0.0.1.evil.test", "::", ""]) assert.equal(isLoopbackHost(h), false, h);
    assert.equal(isLoopbackUrl("http://[::1]:11434"), true);
    assert.equal(isLoopbackUrl("ftp://127.0.0.1"), false);
    assert.equal(isLoopbackUrl("nonsense"), false);
  });
});

describe("dialects", () => {
  it("ollama /api/tags", async () => {
    const s = await serve(ollama);
    const r = await probeEndpoint({ origin: s.origin, dialects: ["ollama"] });
    assert.equal(r.state, "ok");
    assert.equal(r.dialect, "ollama");
    assert.deepEqual(r.models.map((m) => m.id), ["llama3:8b", "qwen2.5:7b"]);
    assert.equal(r.baseUrl, `${s.origin}/v1`);
  });

  it("LM Studio /v1/models", async () => {
    const s = await serve(lmstudio);
    const r = await probeEndpoint({ origin: s.origin, dialects: ["openai"] });
    assert.equal(r.state, "ok");
    assert.equal(r.dialect, "openai");
    assert.deepEqual(r.models, [{ id: "qwen/qwen3-4b" }]);
  });

  it("falls back to /v1/models when /api/tags is absent", async () => {
    const s = await serve(lmstudio);
    const r = await probeEndpoint({ origin: s.origin, dialects: ["ollama", "openai"] });
    assert.equal(r.state, "ok");
    assert.equal(r.dialect, "openai");
    assert.deepEqual(s.hits.map((h) => h.url), ["/api/tags", "/v1/models"]);
  });

  it("sends no credentials", async () => {
    const s = await serve(ollama);
    await probeEndpoint({ origin: s.origin, dialects: ["ollama"] });
    assert.equal(s.hits[0]?.headers.authorization, undefined);
    assert.equal(s.hits[0]?.headers.cookie, undefined);
  });

  it("deduplicates and skips junk entries", async () => {
    const s = await serve((_q, res) => json(res, { data: [{ id: "a" }, { id: "a" }, { id: 5 }, null, { id: "" }] }));
    const r = await probeEndpoint({ origin: s.origin, dialects: ["openai"] });
    assert.deepEqual(r.models, [{ id: "a" }]);
  });
});

describe("states and error classes", () => {
  it("empty model list", async () => {
    for (const [h, d] of [[(_q: IncomingMessage, res: ServerResponse) => json(res, { models: [] }), "ollama"], [(_q: IncomingMessage, res: ServerResponse) => json(res, { data: [] }), "openai"]] as const) {
      const s = await serve(h);
      const r = await probeEndpoint({ origin: s.origin, dialects: [d] });
      assert.equal(r.state, "empty");
      assert.deepEqual(r.models, []);
    }
  });

  it("empty ollama list but populated /v1/models still yields ok", async () => {
    const s = await serve((q, res) => q.url === "/api/tags" ? json(res, { models: [] }) : json(res, { data: [{ id: "m" }] }));
    const r = await probeEndpoint({ origin: s.origin, dialects: ["ollama", "openai"] });
    assert.equal(r.state, "ok");
    assert.equal(r.dialect, "openai");
  });

  it("unreachable (connection refused)", async () => {
    const r = await probeEndpoint({ origin: await deadOrigin(), dialects: ["ollama", "openai"] });
    assert.equal(r.state, "unreachable");
    assert.deepEqual(r.models, []);
  });

  it("unreachable does not retry the second dialect", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; throw new TypeError("fetch failed"); };
    const r = await probeEndpoint({ origin: "http://127.0.0.1:1", dialects: ["ollama", "openai"] }, { fetch });
    assert.equal(r.state, "unreachable");
    assert.equal(calls, 1);
  });

  it("timeout on a service that accepts and never answers", async () => {
    const s = await serve(() => { /* hold */ });
    const t0 = Date.now();
    const r = await probeEndpoint({ origin: s.origin, dialects: ["ollama", "openai"] }, { timeoutMs: 50 });
    assert.equal(r.state, "timeout");
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(s.hits.length, 1);
  });

  it("caller abort propagates instead of reporting a state", async () => {
    const s = await serve(() => { /* hold */ });
    const ac = new AbortController();
    const p = probeEndpoint({ origin: s.origin, dialects: ["openai"] }, { signal: ac.signal, timeoutMs: 5000 });
    setImmediate(() => ac.abort(new Error("stop")));
    await assert.rejects(p, /stop/);
  });

  it("protocol: HTTP errors, redirects, bad JSON, wrong shape, oversize", async () => {
    const cases: [string, H][] = [
      ["500", (_q, res) => json(res, { error: "x" }, 500)],
      ["401", (_q, res) => json(res, { error: "x" }, 401)],
      ["redirect", (_q, res) => { res.writeHead(302, { location: "http://example.invalid/" }); res.end(); }],
      ["not json", (_q, res) => { res.end("<html>"); }],
      ["wrong shape", (_q, res) => json(res, { hello: 1 })],
      ["no ids", (_q, res) => json(res, { data: [{ nope: 1 }] })],
      ["oversize", (_q, res) => { res.end("[" + "0,".repeat(600_000) + "0]"); }],
    ];
    for (const [name, h] of cases) {
      const s = await serve(h);
      const r = await probeEndpoint({ origin: s.origin, dialects: ["openai"] });
      assert.equal(r.state, "protocol", name);
      assert.ok(r.detail, name);
      assert.equal(s.hits.length, 1, `${name}: redirect not followed`);
    }
  });

  it("reports http status", async () => {
    const s = await serve((_q, res) => json(res, {}, 503));
    const r = await probeEndpoint({ origin: s.origin, dialects: ["openai"] });
    assert.equal(r.httpStatus, 503);
  });
});

describe("egress and origin rules", () => {
  const never: typeof globalThis.fetch = async () => { throw new Error("must not be called"); };

  it("refuses non-loopback by default, without touching the network", async () => {
    for (const origin of ["http://192.168.1.20:11434", "http://example.com:1234", "http://0.0.0.0:1234"]) {
      const r = await probeEndpoint({ origin, dialects: ["openai"] }, { fetch: never });
      assert.equal(r.state, "refused", origin);
    }
  });

  it("opt-in without an egress policy still refuses (fail closed)", async () => {
    const r = await probeEndpoint({ origin: "http://192.168.1.20:11434", dialects: ["openai"] }, { fetch: never, allowNonLoopback: true });
    assert.equal(r.state, "refused");
  });

  it("opt-in with a denying policy refuses; with an allowing policy it probes", async () => {
    const deny = await probeEndpoint({ origin: "http://10.0.0.5:1234", dialects: ["openai"] }, { fetch: never, allowNonLoopback: true, egress: { allow: () => false } });
    assert.equal(deny.state, "refused");
    const asked: string[] = [];
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    const ok = await probeEndpoint({ origin: "http://10.0.0.5:1234", dialects: ["openai"] }, { fetch, allowNonLoopback: true, egress: { allow: async (u) => { asked.push(u); return true; } } });
    assert.equal(ok.state, "ok");
    assert.deepEqual(asked, ["http://10.0.0.5:1234/"]);
  });

  it("loopback never consults the egress policy", async () => {
    const s = await serve(lmstudio);
    const r = await probeEndpoint({ origin: s.origin, dialects: ["openai"] }, { egress: { allow: () => { throw new Error("asked"); } } });
    assert.equal(r.state, "ok");
  });

  it("rejects origins with credentials, path, query", async () => {
    for (const origin of ["http://user:pw@127.0.0.1:1234", "http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/?k=v", "file:///etc/passwd", "garbage"]) {
      const r = await probeEndpoint({ origin, dialects: ["openai"] }, { fetch: never });
      assert.equal(r.state, "refused", origin);
    }
  });
});

describe("discoverLocalEndpoints", () => {
  it("one dead service does not hide another; order is stable", async () => {
    const a = await serve(ollama);
    const dead = await deadOrigin();
    const found = await discoverLocalEndpoints({ candidates: [{ origin: dead, dialects: ["openai"], label: "lmstudio" }, { origin: a.origin, dialects: ["ollama", "openai"], label: "ollama" }] });
    assert.deepEqual(found.map((f) => [f.label, f.state]), [["lmstudio", "unreachable"], ["ollama", "ok"]]);
  });

  it("defaults probe the well-known loopback ports only", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (u) => { urls.push(String(u)); throw new TypeError("down"); };
    const found = await discoverLocalEndpoints({ fetch });
    assert.deepEqual(found.map((f) => f.label), ["ollama", "lmstudio"]);
    assert.deepEqual(urls.sort(), ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:1234/v1/models"].sort());
  });
});

describe("no-auth chat adapter wiring", () => {
  it("hands the factory a /v1 base URL and credentials that yield no Authorization", async () => {
    const s = await serve(lmstudio);
    const r = await probeEndpoint({ origin: s.origin, dialects: ["openai"] });
    let seen: { baseUrl: string; auth: unknown; extra?: unknown } | undefined;
    const adapter = createLocalChatAdapter(r, (c: { baseUrl: string; credentials: typeof NO_AUTH; marker?: number }) => {
      seen = { baseUrl: c.baseUrl, auth: c.credentials.authorization({ signal: new AbortController().signal }), extra: c.marker };
      return "adapter";
    }, { marker: 7 });
    assert.equal(adapter, "adapter");
    assert.deepEqual(seen, { baseUrl: `${s.origin}/v1`, auth: undefined, extra: 7 });
  });

  it("accepts an empty endpoint, refuses unusable ones", () => {
    const f = () => "x";
    assert.equal(createLocalChatAdapter({ state: "empty", baseUrl: "http://127.0.0.1:1/v1" }, f), "x");
    for (const state of ["unreachable", "timeout", "refused", "protocol"] as const) assert.throws(() => createLocalChatAdapter({ state, baseUrl: "http://127.0.0.1:1/v1" }, f), TypeError);
  });
});
