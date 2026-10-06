import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWebTools, WEB_CAPABILITIES } from "../../../src/tools/web/tools.ts";
import { createWebFetch } from "../../../src/tools/web/fetch.ts";
import { createWebSearch } from "../../../src/tools/web/search.ts";
import { callWithRepair, validateArgs } from "../../../src/tools/repair.ts";
import { startStub } from "./helpers.ts";

const stubSearch = createWebSearch({ providers: [{ id: "p", search: async () => [{ title: "R", url: "https://r.example/", snippet: "s" }] }] });
const build = (fetchCfg = {}) => createWebTools({ fetch: createWebFetch({ allowPrivate: ["127.0.0.0/8"], ...fetchCfg }), search: stubSearch });

describe("web tools: specs", () => {
  const { tools } = build();
  it("exactly web.fetch and web.search, both external, parallel-safe, with closed schemas", () => {
    assert.deepEqual(tools.map((t) => t.name), ["web.fetch", "web.search"]);
    for (const t of tools) {
      assert.equal(t.effect, "external");
      assert.equal(t.parallelSafe, true);
      assert.equal((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, false);
      assert.ok(t.description.length > 40);
    }
  });
  it("the schemas accept what the implementation accepts and reject what it rejects", () => {
    const f = tools[0]!.inputSchema;
    assert.deepEqual(validateArgs(f, { url: "https://a.example/", mode: "auto", section: "s1", cursor: "c", maxTokens: 500, crawl: false }), []);
    assert.ok(validateArgs(f, { url: "x", mode: "render" }).length > 0);
    assert.ok(validateArgs(f, {}).length > 0);
    const s = tools[1]!.inputSchema;
    assert.deepEqual(validateArgs(s, { query: "q", count: 20, freshness: "year", site: "a.b", lang: "en" }), []);
    assert.ok(validateArgs(s, { query: "q", count: 21 }).length > 0);
  });
});

describe("web tools: execute", () => {
  it("web.fetch success is { isError:false, value }; failures are structured isError results with hint and userAction", async () => {
    const s = await startStub((req, res) => (req.url === "/gone" ? void res.writeHead(404).end() : void res.writeHead(200, { "content-type": "text/plain" }).end("hi")));
    try {
      const f = build().tools[0]!;
      const ok = await f.execute({ url: `http://127.0.0.1:${s.port}/` }, {});
      assert.equal(ok.isError, false);
      assert.equal((ok as { value: { markdown: string } }).value.markdown, "hi");
      const bad = (await f.execute({ url: `http://127.0.0.1:${s.port}/gone` }, {})) as { isError: true; error: Record<string, unknown> };
      assert.equal(bad.isError, true);
      assert.equal(bad.error.code, "not-found");
      assert.ok(bad.error.hint && bad.error.userAction);
      assert.ok(!/\n\s+at /.test(JSON.stringify(bad)) && !("stack" in bad.error), "no stack");
    } finally {
      await s.close();
    }
  });

  it("web.fetch refuses a private address through the tool surface too", async () => {
    const t = createWebTools({ fetch: createWebFetch({}), search: stubSearch }).tools[0]!;
    const out = (await t.execute({ url: "http://169.254.169.254/latest/meta-data/" }, {})) as { isError: true; error: { code: string } };
    assert.equal(out.error.code, "private-address");
  });

  it("web.search returns normalised results; no-provider is a structured failure", async () => {
    const out = (await build().tools[1]!.execute({ query: "q" }, {})) as { isError: false; value: { provider: string; results: unknown[] } };
    assert.equal(out.value.provider, "p");
    assert.equal(out.value.results.length, 1);
    const none = createWebTools({ fetch: createWebFetch({}), search: createWebSearch({ providers: [] }) }).tools[1]!;
    assert.equal(((await none.execute({ query: "q" }, {})) as { error: { code: string } }).error.code, "no-provider");
  });

  it("an unexpected exception becomes internal-error without leaking its message", async () => {
    const t = createWebTools({ fetch: { fetch: async () => { throw new Error("db password hunter2"); } }, search: stubSearch }).tools[0]!;
    const out = (await t.execute({ url: "https://x.example/" }, {})) as { isError: true; error: { code: string } };
    assert.equal(out.error.code, "internal-error");
    assert.ok(!JSON.stringify(out).includes("hunter2"));
  });

  it("the agent id and signal reach web.fetch (cursors are per agent)", async () => {
    let seen: unknown;
    const t = createWebTools({ fetch: { fetch: async (_a, ctx) => { seen = ctx; throw new Error("x"); } }, search: stubSearch }).tools[0]!;
    const ac = new AbortController();
    await t.execute({ url: "https://x.example/" }, { agentId: "a1", signal: ac.signal });
    assert.deepEqual(seen, { agentId: "a1", signal: ac.signal });
  });
});

describe("web tools: argument repair (M2 acceptance 14)", () => {
  it("an invalid web.fetch call is repaired in one round and then runs", async () => {
    const s = await startStub((req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("repaired"));
    try {
      const t = build().tools[0]!;
      let rounds = 0;
      const out = await callWithRepair(t, { url: `http://127.0.0.1:${s.port}/`, maxTokens: "6000" }, { repair: async (req) => (rounds++, { url: (req.args as { url: string }).url, maxTokens: 6000 }) });
      assert.equal(rounds, 1);
      assert.equal(out.repairRounds, 1);
      assert.equal(((out.result as { value: { markdown: string } }).value).markdown, "repaired");
    } finally {
      await s.close();
    }
  });
  it("a second failure is tool-call-invalid and nothing is fetched", async () => {
    const s = await startStub((req, res) => res.end("x"));
    try {
      const t = build().tools[0]!;
      const out = await callWithRepair(t, { url: `http://127.0.0.1:${s.port}/`, maxTokens: "a" }, { repair: async (r) => r.args });
      assert.equal((out.result as { error: { code: string } }).error.code, "tool-call-invalid");
      assert.equal(s.hits.length, 0);
    } finally {
      await s.close();
    }
  });
});

describe("web tools: capability index rows (D103)", () => {
  const { index } = build();
  it("one row per tool, kind tool, external side effects, effect external", () => {
    assert.deepEqual(index.map((r) => r.name), ["web.fetch", "web.search"]);
    assert.deepEqual(index, WEB_CAPABILITIES);
    for (const r of index) {
      assert.equal(r.kind, "tool");
      assert.equal(r.sideEffects, "external");
      assert.equal(r.effect, "external");
      assert.equal(r.id, `tool:${r.name}`);
    }
  });
  it("summary is at most 25 words; useWhen/notFor/inputs are one line; categories are stable ids", () => {
    for (const r of index) {
      assert.ok(r.summary.split(/\s+/).length <= 25, r.name);
      for (const line of [r.useWhen, r.notFor, r.inputs]) assert.ok(line.length > 5 && !line.includes("\n"), r.name);
      assert.match(r.category.primary, /^[a-z]+(\.[a-z]+)+$/);
      assert.ok(r.category.secondary.length <= 2);
    }
    assert.equal(index[0]!.category.primary, "web.browse");
    assert.equal(index[1]!.category.primary, "web.research");
  });
  it("the version is a content hash of the row and the schema, so a change re-indexes", () => {
    const { tools } = build();
    for (const [i, r] of index.entries()) {
      const expect = createHash("sha256").update(JSON.stringify({ n: r.name, s: r.summary, u: r.useWhen, x: r.notFor, i: r.inputs, schema: tools[i]!.inputSchema })).digest("hex").slice(0, 16);
      assert.equal(r.version, expect);
    }
  });
  it("the rows disambiguate the two tools from each other", () => {
    assert.match(index[0]!.notFor, /web\.search/);
    assert.match(index[1]!.notFor, /web\.fetch/);
  });
});
