import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinnedClient, ScanError } from "../../src/discovery/http.ts";
import { SCANNERS } from "../../src/discovery/scanners/index.ts";
import type { ProfileInfo } from "../../src/discovery/ports.ts";
import { startFakeEndpoint } from "../helpers/fake-endpoint.ts";
import type { FakeEndpoint, FakeReply, FakeRequest } from "../helpers/fake-endpoint.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/discovery/${name}.json`, import.meta.url), "utf8"));

const opened: FakeEndpoint[] = [];
async function fake(h: (r: FakeRequest) => FakeReply): Promise<FakeEndpoint> {
  const f = await startFakeEndpoint(h);
  opened.push(f);
  return f;
}
after(async () => {
  await Promise.all(opened.map((f) => f.close()));
});

const lease = (origin: string, headerName = "authorization", headerValue = "Bearer CANARY-KEY-1") => ({ origin, headerName, headerValue });

describe("scanners", () => {
  it("openai-models plain", async () => {
    const data = fixture("openai-plain");
    const f = await fake(() => ({ json: data }));
    const profile: ProfileInfo = { id: "openai-test", discovery: "openai-models", baseUrl: `${f.origin}/v1` };
    const client = createPinnedClient({ baseUrl: profile.baseUrl, lease: lease(f.origin), userAgent: "plur1bus/0.1.0" });
    const res = await SCANNERS["openai-models"](profile, client);
    assert.equal(f.requests[0]!.url, "/v1/models");
    assert.deepEqual(res.entries, [
      { id: "example-chat-large", created: 1_700_000_000_000 },
      { id: "example-embed-small", created: 1_700_000_100_000 },
    ]);
    assert.equal(res.duplicates, 0);
    assert.equal(res.pages, 1);
  });

  it("openai-models OpenRouter extras", async () => {
    const data = fixture("openai-openrouter");
    const f = await fake(() => ({ json: data }));
    const profile: ProfileInfo = { id: "openrouter-test", discovery: "openai-models", baseUrl: `${f.origin}/v1` };
    const client = createPinnedClient({ baseUrl: profile.baseUrl, lease: lease(f.origin), userAgent: "plur1bus/0.1.0" });
    const res = await SCANNERS["openai-models"](profile, client);
    assert.deepEqual(res.entries, [
      {
        id: "example-router/chat-pro",
        displayName: "Example Pro",
        created: 1_700_000_000_000,
        contextWindow: 200000,
        capabilities: ["tools", "structured_output", "reasoning", "vision"],
      },
    ]);
    assert.equal("pricing" in (res.entries[0] ?? {}), false);
  });

  it("anthropic-models pages", async () => {
    const p1 = fixture("anthropic-p1");
    const p2 = fixture("anthropic-p2");
    const f = await fake((r) => {
      if (r.url.includes("after_id=")) return { json: p2 };
      return { json: p1 };
    });
    const profile: ProfileInfo = { id: "anthropic-test", discovery: "anthropic-models", baseUrl: `${f.origin}/v1` };
    const client = createPinnedClient({ baseUrl: profile.baseUrl, lease: lease(f.origin), userAgent: "plur1bus/0.1.0" });
    const res = await SCANNERS["anthropic-models"](profile, client);
    assert.equal(f.requests[0]!.url, "/v1/models?limit=1000");
    assert.equal(f.requests[0]!.headers["anthropic-version"], "2023-06-01");
    assert.equal(f.requests[1]!.url, "/v1/models?limit=1000&after_id=example-claude-3-5-sonnet");
    assert.equal(f.requests[1]!.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(res.entries.map((e) => e.id), ["example-claude-3-5-sonnet", "example-claude-3-haiku"]);
    assert.equal(res.pages, 2);
  });

  it("google-models pages and prefix", async () => {
    const p1 = fixture("google-p1");
    const p2 = fixture("google-p2");
    const f = await fake((r) => {
      if (r.url.includes("pageToken=")) return { json: p2 };
      return { json: p1 };
    });
    const profile: ProfileInfo = { id: "google-test", discovery: "google-models", baseUrl: `${f.origin}/v1beta` };
    const client = createPinnedClient({
      baseUrl: profile.baseUrl,
      lease: lease(f.origin, "x-goog-api-key", "CANARY-KEY-2"),
      userAgent: "plur1bus/0.1.0",
    });
    const res = await SCANNERS["google-models"](profile, client);
    assert.equal(f.requests[0]!.url, "/v1beta/models?pageSize=1000");
    assert.equal(f.requests[0]!.headers["x-goog-api-key"], "CANARY-KEY-2");
    assert.equal(f.requests[1]!.url, "/v1beta/models?pageSize=1000&pageToken=tok-2");
    assert.equal(f.requests[1]!.headers["x-goog-api-key"], "CANARY-KEY-2");
    assert.ok(!f.requests[0]!.url.includes("CANARY") && !f.requests[0]!.url.includes("key="));
    assert.ok(!f.requests[1]!.url.includes("CANARY") && !f.requests[1]!.url.includes("key="));
    assert.deepEqual(res.entries, [
      {
        id: "example-gemini-1.5-pro",
        displayName: "Example Gemini 1.5 Pro",
        contextWindow: 2000000,
      },
      {
        id: "example-text-embedding-004",
        displayName: "Example Text Embedding 004",
        kind: "embedding",
        contextWindow: 2048,
      },
    ]);
  });

  it("ollama-tags keeps the tag", async () => {
    const data = fixture("ollama-tags");
    const f = await fake(() => ({ json: data }));
    const profile: ProfileInfo = { id: "ollama-test", discovery: "ollama-tags", baseUrl: f.origin };
    const client = createPinnedClient({ baseUrl: profile.baseUrl, lease: null, userAgent: "plur1bus/0.1.0" });
    const res = await SCANNERS["ollama-tags"](profile, client);
    assert.equal(f.requests[0]!.url, "/api/tags");
    assert.deepEqual(res.entries, [
      {
        id: "example-llama:latest",
        created: Date.parse("2026-08-01T12:00:00.000Z"),
      },
    ]);
  });

  it("every scanner refuses a missing envelope field", async () => {
    const f = await fake(() => ({ json: {} }));
    for (const kind of ["openai-models", "anthropic-models", "google-models", "ollama-tags"] as const) {
      const profile: ProfileInfo = { id: "test", discovery: kind, baseUrl: f.origin };
      const client = createPinnedClient({ baseUrl: f.origin, lease: null, userAgent: "plur1bus/0.1.0" });
      await assert.rejects(
        SCANNERS[kind](profile, client),
        (e: unknown) => e instanceof ScanError && e.result === "failed:invalid" && e.reason === "bad_envelope",
      );
    }
  });

  it("a response URL is never fetched", async () => {
    const second = await fake(() => ({ json: {} }));
    const targetUrl = `${second.origin}/steal`;

    const fOpenai = await fake(() => ({ json: { data: [{ id: "m1" }], next: targetUrl } }));
    const fAnthropic = await fake(() => ({
      json: { data: [{ id: "m1" }], has_more: false, next_page_url: targetUrl },
    }));
    const fGoogle = await fake((r) => ({
      json: r.url.includes("pageToken=")
        ? { models: [] }
        : { models: [{ name: "models/m1" }], nextPageToken: targetUrl },
    }));

    const c1 = createPinnedClient({ baseUrl: fOpenai.origin, lease: null, userAgent: "plur1bus/0.1.0" });
    await SCANNERS["openai-models"]({ id: "o", discovery: "openai-models", baseUrl: fOpenai.origin }, c1);

    const c2 = createPinnedClient({ baseUrl: fAnthropic.origin, lease: null, userAgent: "plur1bus/0.1.0" });
    await SCANNERS["anthropic-models"]({ id: "a", discovery: "anthropic-models", baseUrl: fAnthropic.origin }, c2);

    const c3 = createPinnedClient({ baseUrl: fGoogle.origin, lease: null, userAgent: "plur1bus/0.1.0" });
    // Google will send targetUrl as pageToken query parameter to fGoogle, NOT to second!
    await SCANNERS["google-models"]({ id: "g", discovery: "google-models", baseUrl: fGoogle.origin }, c3);

    assert.equal(second.requests.length, 0);
  });

  it("more than 10 pages fails", async () => {
    let page = 0;
    const f = await fake(() => {
      page++;
      return {
        json: {
          data: [{ id: `m${page}` }],
          has_more: true,
          last_id: `cursor-${page}`,
        },
      };
    });
    const profile: ProfileInfo = { id: "anthropic-test", discovery: "anthropic-models", baseUrl: f.origin };
    const client = createPinnedClient({ baseUrl: f.origin, lease: null, userAgent: "plur1bus/0.1.0" });
    await assert.rejects(
      SCANNERS["anthropic-models"](profile, client),
      (e: unknown) => e instanceof ScanError && e.result === "failed:invalid" && e.reason === "too_many_pages",
    );
  });

  it("a failure on page 2 returns nothing", async () => {
    let call = 0;
    const f = await fake(() => {
      call += 1;
      if (call === 1) return { json: { data: [{ id: "m1" }], has_more: true, last_id: "m1" } };
      return { status: 500 };
    });
    const profile: ProfileInfo = { id: "anthropic-test", discovery: "anthropic-models", baseUrl: f.origin };
    const client = createPinnedClient({ baseUrl: f.origin, lease: null, userAgent: "plur1bus/0.1.0" });
    await assert.rejects(
      SCANNERS["anthropic-models"](profile, client),
      (e: unknown) => e instanceof ScanError && e.result === "failed:server" && e.reason === "http_500",
    );
  });

  it("wrong content type, oversized body, 5001 entries, invalid id and timeout are refused through each scanner", async () => {
    for (const kind of ["openai-models", "anthropic-models", "google-models", "ollama-tags"] as const) {
      // 1. wrong content type
      const fHtml = await fake(() => ({ body: Buffer.from("<html>"), headers: { "Content-Type": "text/html" } }));
      const cHtml = createPinnedClient({ baseUrl: fHtml.origin, lease: null, userAgent: "plur1bus/0.1.0" });
      await assert.rejects(
        SCANNERS[kind]({ id: "t", discovery: kind, baseUrl: fHtml.origin }, cHtml),
        (e: unknown) => e instanceof ScanError && e.reason === "content_type",
      );

      // 2. oversized body
      const big = Buffer.alloc(4194304 + 1, 0x20);
      const fBig = await fake(() => ({ body: big, headers: { "Content-Type": "application/json" } }));
      const cBig = createPinnedClient({ baseUrl: fBig.origin, lease: null, userAgent: "plur1bus/0.1.0" });
      await assert.rejects(
        SCANNERS[kind]({ id: "t", discovery: kind, baseUrl: fBig.origin }, cBig),
        (e: unknown) => e instanceof ScanError && e.reason === "response_too_large",
      );

      // 3. 5001 entries
      const entries5001 = Array.from({ length: 5001 }, (_, i) => ({ id: `m${i}`, name: `models/m${i}` }));
      const f5001 = await fake(() => ({
        json: kind === "google-models" || kind === "ollama-tags"
          ? { models: entries5001 }
          : { data: entries5001, has_more: false },
      }));
      const c5001 = createPinnedClient({ baseUrl: f5001.origin, lease: null, userAgent: "plur1bus/0.1.0" });
      await assert.rejects(
        SCANNERS[kind]({ id: "t", discovery: kind, baseUrl: f5001.origin }, c5001),
        (e: unknown) => e instanceof ScanError && e.reason === "too_many_entries",
      );

      // 4. invalid id
      const fBadId = await fake(() => ({
        json: kind === "google-models" || kind === "ollama-tags"
          ? { models: [{ name: "bad id with spaces" }] }
          : { data: [{ id: "bad id with spaces" }], has_more: false },
      }));
      const cBadId = createPinnedClient({ baseUrl: fBadId.origin, lease: null, userAgent: "plur1bus/0.1.0" });
      await assert.rejects(
        SCANNERS[kind]({ id: "t", discovery: kind, baseUrl: fBadId.origin }, cBadId),
        (e: unknown) => e instanceof ScanError && e.reason === "invalid_entry",
      );

      // 5. timeout
      const fStall = await fake(() => ({ stall: true }));
      const cStall = createPinnedClient({
        baseUrl: fStall.origin,
        lease: null,
        userAgent: "plur1bus/0.1.0",
        limits: { requestTimeoutMs: 50 },
      });
      await assert.rejects(
        SCANNERS[kind]({ id: "t", discovery: kind, baseUrl: fStall.origin }, cStall),
        (e: unknown) => e instanceof ScanError && e.reason === "request_timeout",
      );
    }
  });

  it("manual has no scanner", () => {
    assert.deepEqual(Object.keys(SCANNERS).sort(), ["anthropic-models", "google-models", "ollama-tags", "openai-models"]);
    assert.equal("manual" in SCANNERS, false);
  });
});
