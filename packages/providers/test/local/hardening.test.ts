import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { createChatCompletionsAdapter } from "../../src/client.ts";
import { availabilityOf, createLocalChatAdapter, discoverLocalEndpoints, isLoopbackHost, isLoopbackUrl, NO_AUTH, probeEndpoint } from "../../src/local/index.ts";
import type { DiscoveredEndpoint, ProbeResult } from "../../src/local/index.ts";
import { basicRequest, hold, startStub } from "../helpers/stub.ts";

const T = { timeout: 15_000 };
const originOf = (baseUrl: string) => baseUrl.replace(/\/v1$/, "");
const models = (res: ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "m1" }] })); };

async function deadOrigin(): Promise<string> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}

describe("no credentials on the wire", () => {
  it("probe and discovery requests carry no authorization/cookie", T, async () => {
    const s = await startStub((_q, res) => models(res));
    try {
      await probeEndpoint({ origin: originOf(s.baseUrl), dialects: ["openai"] });
      await discoverLocalEndpoints({ candidates: [{ origin: originOf(s.baseUrl), dialects: ["ollama", "openai"], label: "x" }] });
      assert.ok(s.requests.length >= 2);
      for (const r of s.requests) {
        assert.equal(r.headers.authorization, undefined);
        assert.equal(r.headers["proxy-authorization"], undefined);
        assert.equal(r.headers.cookie, undefined);
      }
    } finally { await s.close(); }
  });

  it("a chat through createLocalChatAdapter + the real adapter records no authorization header", T, async () => {
    const s = await startStub((_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
      res.write(chunk({ id: "1", object: "chat.completion.chunk", model: "m1", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }));
      res.write(chunk({ id: "1", object: "chat.completion.chunk", model: "m1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
    });
    try {
      const adapter = createLocalChatAdapter({ state: "ok", baseUrl: s.baseUrl }, createChatCompletionsAdapter);
      for await (const _ of adapter.stream({ ...basicRequest, model: "m1" })) { /* drain */ }
      assert.equal(s.requests.length, 1);
      assert.equal(s.requests[0]?.url, "/v1/chat/completions");
      assert.equal(s.requests[0]?.headers.authorization, undefined);
      assert.equal(s.requests[0]?.headers.cookie, undefined);
    } finally { await s.close(); }
  });
});

describe("discovery never blocks and never throws", () => {
  it("a hanging server is reported as timeout within the deadline", T, async () => {
    const s = await startStub((_q, res) => hold(res));
    try {
      const t0 = Date.now();
      const found = await discoverLocalEndpoints({ deadlineMs: 300, timeoutMs: 10_000, candidates: [
        { origin: originOf(s.baseUrl), dialects: ["ollama", "openai"], label: "a" },
        { origin: originOf(s.baseUrl), dialects: ["openai"], label: "b" },
      ] });
      assert.ok(Date.now() - t0 < 300 + 1000, `took ${Date.now() - t0} ms`);
      assert.deepEqual(found.map((f) => [f.label, f.state]), [["a", "timeout"], ["b", "timeout"]]);
      assert.ok(found.every((f) => f.detail && f.models.length === 0));
    } finally { await s.close(); }
  });

  it("the deadline also bounds a hung fetch that ignores its signal; finished candidates keep their result and order", T, async () => {
    const live = await startStub((_q, res) => models(res));
    try {
      const fetch: typeof globalThis.fetch = (u, init) => String(u).includes("127.0.0.1:9/") ? new Promise(() => {}) : globalThis.fetch(u, init);
      const t0 = Date.now();
      const found = await discoverLocalEndpoints({ deadlineMs: 200, fetch, candidates: [
        { origin: "http://127.0.0.1:9", dialects: ["openai"], label: "hung" },
        { origin: originOf(live.baseUrl), dialects: ["openai"], label: "live" },
      ] });
      assert.ok(Date.now() - t0 < 1200);
      assert.deepEqual(found.map((f) => [f.label, f.state]), [["hung", "timeout"], ["live", "ok"]]);
    } finally { await live.close(); }
  });

  it("refused port is unreachable; nothing throws", T, async () => {
    const found = await discoverLocalEndpoints({ candidates: [{ origin: await deadOrigin(), dialects: ["ollama", "openai"], label: "dead" }] });
    assert.equal(found[0]?.state, "unreachable");
  });

  it("per-request timeoutMs still applies below the deadline", T, async () => {
    const s = await startStub((_q, res) => hold(res));
    try {
      const t0 = Date.now();
      const found = await discoverLocalEndpoints({ timeoutMs: 50, deadlineMs: 5000, candidates: [{ origin: originOf(s.baseUrl), dialects: ["openai"] }] });
      assert.equal(found[0]?.state, "timeout");
      assert.ok(Date.now() - t0 < 1500);
    } finally { await s.close(); }
  });

  it("a caller abort rejects", T, async () => {
    const s = await startStub((_q, res) => hold(res));
    try {
      const ac = new AbortController();
      const p = discoverLocalEndpoints({ signal: ac.signal, candidates: [{ origin: originOf(s.baseUrl), dialects: ["openai"] }] });
      setTimeout(() => ac.abort(new Error("stop")), 30);
      await assert.rejects(p, /stop/);
    } finally { await s.close(); }
  });
});

describe("availabilityOf", () => {
  const r = (state: ProbeResult["state"], ids: string[] = [], detail?: string): ProbeResult =>
    ({ state, baseUrl: "http://127.0.0.1:1/v1", models: ids.map((id) => ({ id })), ...(detail === undefined ? {} : { detail }) });
  it("maps every probe state", () => {
    assert.deepEqual(availabilityOf(r("ok", ["a", "b"])), { status: "available", models: ["a", "b"] });
    assert.deepEqual(availabilityOf(r("empty")), { status: "unavailable", reason: "no_models", models: [] });
    for (const s of ["unreachable", "timeout", "refused", "protocol"] as const) {
      assert.deepEqual(availabilityOf(r(s, [], "why")), { status: "unavailable", reason: s, models: [], detail: "why" });
    }
  });
  it("accepts a DiscoveredEndpoint", () => {
    const d: DiscoveredEndpoint = { ...r("ok", ["m"]), label: "x", origin: "http://127.0.0.1:1" };
    assert.equal(availabilityOf(d).status, "available");
  });
});

describe("createLocalChatAdapter rules", () => {
  const ok = (baseUrl: string) => ({ state: "ok" as const, baseUrl });
  const seen = (c: { credentials: unknown }) => c.credentials;
  it("loopback always gets NO_AUTH", () => {
    assert.equal(createLocalChatAdapter(ok("http://127.0.0.1:1/v1"), seen), NO_AUTH);
    assert.equal(createLocalChatAdapter(ok("http://[::1]:1/v1"), seen, { headers: { "x-title": "t" } }), NO_AUTH);
  });
  it("loopback + credentials or auth-ish headers is a TypeError", () => {
    const bad: object[] = [
      { credentials: { authorization: () => "Bearer x" } },
      { headers: { Authorization: "Bearer x" } },
      { headers: { "PROXY-AUTHORIZATION": "x" } },
      { headers: { cookie: "a=b" } },
    ];
    for (const extra of bad) assert.throws(() => createLocalChatAdapter(ok("http://localhost:1/v1"), seen, extra), /loopback/);
  });
  it("non-loopback needs the explicit option; NO_AUTH stays the default; explicit credentials pass through", () => {
    assert.throws(() => createLocalChatAdapter(ok("http://192.168.1.5:1234/v1"), seen), TypeError);
    assert.throws(() => createLocalChatAdapter(ok("https://example.com/v1"), seen, undefined, {}), TypeError);
    assert.equal(createLocalChatAdapter(ok("http://192.168.1.5:1234/v1"), seen, undefined, { allowNonLoopback: true }), NO_AUTH);
    const creds = { authorization: () => undefined };
    assert.equal(createLocalChatAdapter(ok("https://box.lan/v1"), seen, { credentials: creds }, { allowNonLoopback: true }), creds);
  });
  it("still refuses unusable endpoints", () => {
    assert.throws(() => createLocalChatAdapter({ state: "unreachable", baseUrl: "http://127.0.0.1:1/v1" }, seen), /not usable/);
  });
});

describe("loopback predicate table", () => {
  it("accepts", () => {
    for (const u of ["http://[::1]:11434", "http://127.0.0.2", "http://localhost", "http://LOCALHOST:1234", "http://127.1:11434", "https://127.0.0.1", "http://127.0.0.1:11434/v1"]) assert.equal(isLoopbackUrl(u), true, u);
    for (const h of ["127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
  });
  it("refuses (fail closed)", () => {
    for (const u of ["http://localhost.", "http://0.0.0.0", "http://[::ffff:127.0.0.1]", "http://127.0.0.1.nip.io", "http://127.0.0.1@evil.example", "http://evil.example#@127.0.0.1", "ftp://127.0.0.1", "127.0.0.1", ""]) assert.equal(isLoopbackUrl(u), false, u);
    for (const h of ["localhost.", "::ffff:127.0.0.1", "::ffff:7f00:1", "0.0.0.0", "127.0.0.1.nip.io"]) assert.equal(isLoopbackHost(h), false, h);
  });
  it("a path is not allowed for a probe origin", async () => {
    const never: typeof globalThis.fetch = async () => { throw new Error("must not be called"); };
    const r = await probeEndpoint({ origin: "http://127.0.0.1:11434/v1", dialects: ["openai"] }, { fetch: never });
    assert.equal(r.state, "refused");
  });
});
