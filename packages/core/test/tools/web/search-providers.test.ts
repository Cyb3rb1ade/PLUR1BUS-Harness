// Brave, Tavily and Exa against recorded fixtures (hand-written JSON in each vendor's documented response format, no real
// keys, no real data). The HTTP call is a fake `ApiClient`; nothing leaves the process.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWebSearch } from "../../../src/tools/web/search.ts";
import { WebFailure } from "../../../src/tools/web/failure.ts";
import { KEYED_PROVIDER_IDS, createKeyedProvider, createRateLimiter, retryAfterSeconds, scrub, type ApiReply, type ApiRequest, type KeyedProviderId } from "../../../src/tools/web/search-providers.ts";

const KEY = ["fixture", "key", "q7r2m9"].join("_");
const fx = (p: string): Buffer => readFileSync(new URL(`../../fixtures/web-search/${p}`, import.meta.url));
const reply = (status: number, body: Buffer | string, headers: ApiReply["headers"] = {}): ApiReply => ({ status, body: Buffer.from(body), headers });
const T0 = Date.parse("2026-10-16T09:00:00Z");

function setup(id: KeyedProviderId, replies: Array<ApiReply | Error>, o: { key?: string | null; sleeps?: number[]; interval?: number; t?: { now: number } } = {}) {
  const seen: ApiRequest[] = [];
  const clock = o.t ?? { now: T0 };
  const outcomes: Array<WebFailure | undefined> = [];
  const provider = createKeyedProvider(id, {
    request: async (req) => {
      seen.push(req);
      const r = replies.shift();
      if (!r) throw new Error("no more replies");
      if (r instanceof Error) throw r;
      return r;
    },
    apiKey: async () => (o.key === undefined ? KEY : o.key),
    now: () => clock.now,
    sleep: async (ms) => { o.sleeps?.push(ms); clock.now += ms; },
    limiter: createRateLimiter({ now: () => clock.now, minIntervalMs: o.interval ?? 0 }),
    onOutcome: (f) => outcomes.push(f),
  });
  return { provider, seen, outcomes, clock };
}
const search = (provider: ReturnType<typeof setup>["provider"], args: Parameters<ReturnType<typeof createWebSearch>["search"]>[0] = { query: "harness memory benchmarks" }) =>
  createWebSearch({ providers: [provider], now: () => T0 }).search(args);
const rejects = (p: Promise<unknown>, code: string, extra: Record<string, unknown> = {}) =>
  assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code && Object.entries(extra).every(([k, v]) => (e.extra as Record<string, unknown>)[k] === v), `expected ${code}`);

describe("web.search keyed providers: normalisation of recorded answers", () => {
  const expectFirst = {
    brave: { title: "Memory benchmarks for agent harnesses", url: "https://docs.example.org/guides/memory-benchmarks", snippet: "How a harness is measured: recall at k, latency & cost, with a worked example.", publishedAt: "2026-09-30T08:15:00.000Z", source: "docs.example.org" },
    tavily: { title: "Memory benchmarks for agent harnesses", url: "https://docs.example.org/guides/memory-benchmarks", snippet: "How a harness is measured: recall at k, latency and cost, with a worked example. Bold markup is stripped.", publishedAt: "2026-09-30T08:15:00.000Z", source: "docs.example.org" },
    exa: { title: "Memory benchmarks for agent harnesses", url: "https://docs.example.org/guides/memory-benchmarks", snippet: "How a harness is measured: recall at k, latency and cost, with a worked example. The page goes on at length about fixtures.", publishedAt: "2026-09-30T08:15:00.000Z", source: "docs.example.org" },
  } as const;
  for (const id of KEYED_PROVIDER_IDS) {
    it(`${id}: maps the recorded answer to title, url, snippet, source and time; drops non-web links`, async () => {
      const { provider } = setup(id, [reply(200, fx(`${id}/ok.json`))]);
      const out = await search(provider);
      assert.equal(out.provider, id);
      assert.equal(out.provenance.provider, id);
      assert.equal(out.results.length, 2);
      assert.deepEqual(out.results[0], expectFirst[id]);
      assert.equal(out.results[1]!.source, "blog.example.net");
      assert.equal(out.results[1]!.publishedAt, undefined);
      assert.ok(out.results.every((r) => /^https?:\/\//.test(r.url)));
    });
    it(`${id}: an answer without results is an empty list, not a failure`, async () => {
      const { provider } = setup(id, [reply(200, fx(id === "brave" ? "brave/empty.json" : `${id}/empty.json`))]);
      const out = await search(provider);
      assert.deepEqual(out.results, []);
      assert.equal(out.provider, id);
    });
  }
  it("brave: an explicit empty results list is empty too", async () => {
    const { provider } = setup("brave", [reply(200, fx("brave/empty-list.json"))]);
    assert.deepEqual((await search(provider)).results, []);
  });
  it("exa joins highlights when there is no text", async () => {
    const { provider } = setup("exa", [reply(200, fx("exa/ok.json"))]);
    assert.equal((await search(provider)).results[1]!.snippet, "A short field report. … It compares three harnesses.");
  });
});

describe("web.search keyed providers: the request", () => {
  it("brave: GET with the key in a header only; count, freshness, site and language mapped", async () => {
    const { provider, seen } = setup("brave", [reply(200, fx("brave/empty.json"))]);
    await search(provider, { query: "harness", count: 12, freshness: "week", site: "docs.example.org", lang: "de-CH" });
    const r = seen[0]!;
    assert.equal(r.method, "GET");
    const u = new URL(r.url);
    assert.equal(u.origin + u.pathname, "https://api.search.brave.com/res/v1/web/search");
    assert.equal(u.searchParams.get("q"), "harness site:docs.example.org");
    assert.equal(u.searchParams.get("count"), "12");
    assert.equal(u.searchParams.get("freshness"), "pw");
    assert.equal(u.searchParams.get("search_lang"), "de");
    assert.equal(r.headers["x-subscription-token"], KEY);
    assert.ok(!r.url.includes(KEY) && !JSON.stringify(r.body ?? "").includes(KEY));
  });
  it("tavily: POST JSON with a bearer header; time range and include_domains mapped", async () => {
    const { provider, seen } = setup("tavily", [reply(200, fx("tavily/empty.json"))]);
    await search(provider, { query: "harness", count: 5, freshness: "month", site: "docs.example.org" });
    const r = seen[0]!;
    assert.equal(r.method, "POST");
    assert.equal(r.url, "https://api.tavily.com/search");
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    const body = JSON.parse(r.body!);
    assert.deepEqual({ q: body.query, n: body.max_results, t: body.time_range, d: body.include_domains, a: body.include_answer, raw: body.include_raw_content }, { q: "harness", n: 5, t: "month", d: ["docs.example.org"], a: false, raw: false });
    assert.ok(!r.url.includes(KEY) && !r.body!.includes(KEY));
  });
  it("exa: POST JSON with x-api-key; freshness becomes a start date relative to the clock", async () => {
    const { provider, seen } = setup("exa", [reply(200, fx("exa/empty.json"))]);
    await search(provider, { query: "harness", freshness: "day", site: "docs.example.org" });
    const r = seen[0]!;
    assert.equal(r.url, "https://api.exa.ai/search");
    assert.equal(r.headers["x-api-key"], KEY);
    const body = JSON.parse(r.body!);
    assert.equal(body.startPublishedDate, "2026-10-15T09:00:00.000Z");
    assert.deepEqual(body.includeDomains, ["docs.example.org"]);
    assert.equal(body.numResults, 8);
    assert.ok(!r.url.includes(KEY) && !r.body!.includes(KEY));
  });
});

describe("web.search keyed providers: failures", () => {
  for (const id of KEYED_PROVIDER_IDS) {
    it(`${id}: 401 is an http-error that names the key problem, not the key`, async () => {
      const { provider, outcomes } = setup(id, [reply(401, fx(`${id}/unauthorized.json`))]);
      await rejects(provider.search({ query: "q", count: 8 }), "http-error", { status: 401 });
      const f = outcomes[0]!;
      assert.match(f.message, /rejected the API key/);
      assert.ok(!f.message.includes(KEY));
    });
    it(`${id}: 429 with Retry-After beyond the inline limit fails fast with the delay and starts a cooldown`, async () => {
      const { provider, seen } = setup(id, [reply(429, fx(`${id}/rate-limited.json`), { "retry-after": "45" })]);
      await rejects(provider.search({ query: "q", count: 8 }), "rate-limited", { retryAfterSeconds: 45, status: 429 });
      // the cooldown answers the next call without touching the API
      await rejects(provider.search({ query: "q", count: 8 }), "rate-limited");
      assert.equal(seen.length, 1);
    });
    it(`${id}: 5xx is an http-error with the status`, async () => {
      const { provider } = setup(id, [reply(503, "<html>upstream gone</html>")]);
      await rejects(provider.search({ query: "q", count: 8 }), "http-error", { status: 503 });
    });
    it(`${id}: broken JSON is an http-error`, async () => {
      const { provider } = setup(id, [reply(200, '{"results": [ {"title": ')]);
      await rejects(provider.search({ query: "q", count: 8 }), "http-error");
    });
    it(`${id}: valid JSON of the wrong shape is an http-error`, async () => {
      const { provider } = setup(id, [reply(200, "[1,2,3]")]);
      await rejects(provider.search({ query: "q", count: 8 }), "http-error");
    });
    it(`${id}: no key stored is no-provider`, async () => {
      const { provider, seen } = setup(id, [], { key: null });
      await rejects(provider.search({ query: "q", count: 8 }), "no-provider");
      assert.equal(seen.length, 0);
    });
  }
  it("a short Retry-After is waited out once inside the call", async () => {
    const sleeps: number[] = [];
    const { provider, seen } = setup("tavily", [reply(429, "{}", { "retry-after": "1" }), reply(200, fx("tavily/ok.json"))], { sleeps });
    const out = await search(provider);
    assert.equal(out.results.length, 2);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(seen.length, 2);
  });
  it("a second 429 after the inline wait gives up and cools down", async () => {
    const { provider, seen } = setup("exa", [reply(429, "{}", { "retry-after": "1" }), reply(429, "{}", { "retry-after": "20" })]);
    await rejects(provider.search({ query: "q", count: 8 }), "rate-limited", { retryAfterSeconds: 20 });
    await rejects(provider.search({ query: "q", count: 8 }), "rate-limited");
    assert.equal(seen.length, 2);
  });
  it("without a usable Retry-After the cooldown is 30 s and is reported", async () => {
    const t = { now: T0 };
    const { provider, seen } = setup("brave", [reply(429, "{}"), reply(200, fx("brave/ok.json"))], { t });
    await rejects(provider.search({ query: "q", count: 8 }), "rate-limited", { retryAfterSeconds: 30 });
    t.now += 31_000; // the cooldown has passed
    assert.equal((await provider.search({ query: "q", count: 8 })).length, 3);
    assert.equal(seen.length, 2);
  });
  it("a plan quota answer (402, 432, 433) is rate-limited, not a retry loop", async () => {
    for (const status of [402, 432, 433]) {
      const { provider } = setup("tavily", [reply(status, "{}")]);
      await rejects(provider.search({ query: "q", count: 8 }), "rate-limited", { status });
    }
  });
  it("spacing between requests waits on the injected sleep", async () => {
    const sleeps: number[] = [];
    const { provider, seen } = setup("brave", [reply(200, fx("brave/empty.json")), reply(200, fx("brave/empty.json"))], { sleeps, interval: 1500 });
    await provider.search({ query: "q", count: 8 });
    await provider.search({ query: "q", count: 8 });
    assert.deepEqual(sleeps, [1500]);
    assert.equal(seen.length, 2);
  });
  it("a spacing wait beyond the inline limit is refused with rate-limited, without a request", async () => {
    const sleeps: number[] = [];
    const { provider, seen } = setup("brave", [reply(200, fx("brave/empty.json"))], { sleeps, interval: 5000 });
    await provider.search({ query: "q", count: 8 });
    await rejects(provider.search({ query: "q", count: 8 }), "rate-limited");
    assert.equal(seen.length, 1);
    assert.deepEqual(sleeps, []);
  });
  it("transport failures pass through typed; unknown errors become a fixed sentence", async () => {
    const egress = new WebFailure("egress-denied", "api.search.brave.com is not in egress.allowHosts");
    await rejects(setup("brave", [egress]).provider.search({ query: "q", count: 8 }), "egress-denied");
    const f = await setup("exa", [new Error(`socket hang up for ${KEY}`)]).provider.search({ query: "q", count: 8 }).catch((e: unknown) => e);
    assert.ok(f instanceof WebFailure);
    assert.equal(f.code, "network-error");
    assert.ok(!f.message.includes(KEY));
  });
});

describe("web.search keyed providers: the key never surfaces", () => {
  it("is scrubbed from a transport failure that echoes it, plain and URL-encoded", async () => {
    const key = "a b/c+d";
    const leaky = new WebFailure("network-error", `bad request to https://x.example/?k=${encodeURIComponent(key)} with ${key}`);
    const p = createKeyedProvider("brave", { request: async () => { throw leaky; }, apiKey: async () => key });
    const f = await p.search({ query: "q", count: 8 }).catch((e: unknown) => e);
    assert.ok(f instanceof WebFailure);
    assert.ok(!f.message.includes(key) && !f.message.includes(encodeURIComponent(key)), f.message);
    assert.equal(scrub("nothing here", key), "nothing here");
  });
  it("never reaches the search result's skipped list, hint, userAction or trace", async () => {
    const traces: unknown[] = [];
    const bad = createKeyedProvider("tavily", { request: async () => reply(401, `{"detail":"bad key ${KEY}"}`), apiKey: async () => KEY });
    const good = createKeyedProvider("exa", { request: async () => reply(200, fx("exa/ok.json")), apiKey: async () => KEY });
    const out = await createWebSearch({ providers: [bad, good], trace: (e) => traces.push(e) }).search({ query: "q" });
    assert.deepEqual(out.skipped, [{ provider: "tavily", reason: "error" }]);
    assert.ok(!JSON.stringify([out, traces]).includes(KEY));
    const failure = await createWebSearch({ providers: [bad] }).search({ query: "q" }).catch((e: unknown) => e);
    assert.ok(failure instanceof WebFailure);
    assert.ok(!JSON.stringify([failure.toResult(), failure.message, failure.hint, failure.userAction]).includes(KEY));
  });
});

describe("Retry-After parsing", () => {
  it("reads seconds, HTTP dates and x-ratelimit-reset; clamps and ignores junk", () => {
    assert.equal(retryAfterSeconds({ "retry-after": "12" }, T0), 12);
    assert.equal(retryAfterSeconds({ "retry-after": new Date(T0 + 5000).toUTCString() }, T0), 5);
    assert.equal(retryAfterSeconds({ "retry-after": new Date(T0 - 5000).toUTCString() }, T0), 0);
    assert.equal(retryAfterSeconds({ "retry-after": "999999" }, T0), 3600);
    assert.equal(retryAfterSeconds({ "x-ratelimit-reset": "1, 86400" }, T0), 1);
    assert.equal(retryAfterSeconds({ "retry-after": "soon" }, T0), undefined);
    assert.equal(retryAfterSeconds({ "retry-after": ["7"] }, T0), 7);
    assert.equal(retryAfterSeconds({}, T0), undefined);
  });
});
