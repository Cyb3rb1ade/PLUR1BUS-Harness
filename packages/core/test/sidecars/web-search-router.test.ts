// web.search over SearXNG plus Brave, Tavily and Exa: selection per agent from `modules.web-search`, the no-provider
// path, fallback, the per-session snapshot, keys from the secret store, rate limits and redaction. The vendors are one
// loopback stub that serves the recorded fixtures; nothing leaves the host.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createConfiguredWebSearch, parseWebSearchSettings, chainFor, WEB_SEARCH_MODULE, type ConfiguredWebSearchOptions } from "../../src/sidecars/web-search-router.ts";
import { WebFailure } from "../../src/tools/web/failure.ts";
import type { SearchTrace } from "../../src/tools/web/search.ts";
import { startStub, never, type Stub } from "../tools/web/helpers.ts";

const KEYS: Record<string, string> = { "web-search.brave": ["fixture", "brave", "p3k8"].join("_"), "web-search.tavily": ["fixture", "tavily", "d6v1"].join("_"), "web-search.exa": ["fixture", "exa", "m2x9"].join("_") };
const fx = (p: string): Buffer => readFileSync(new URL(`../fixtures/web-search/${p}`, import.meta.url));
const open: Stub[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const send = (res: http.ServerResponse, body: Buffer | string, status = 200, headers: Record<string, string> = {}): void => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(body); };
/** One stub for the three vendors (paths /brave, /tavily, /exa) and a SearXNG (/search); each defaults to its fixture. */
async function vendors(over: Record<string, Handler> = {}): Promise<Stub> {
  const s = await startStub((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const h = over[path];
    if (h) return h(req, res);
    if (path === "/brave") return send(res, fx("brave/ok.json"));
    if (path === "/tavily") return send(res, fx("tavily/ok.json"));
    if (path === "/exa") return send(res, fx("exa/ok.json"));
    if (path === "/search") return send(res, JSON.stringify({ results: [{ title: "From SearXNG", url: "https://searx.example.org/a", content: "snippet" }] }));
    res.writeHead(404); res.end();
  });
  open.push(s);
  return s;
}

interface Rig { config: { sidecars?: Record<string, unknown>; modules?: Record<string, unknown> } }
function rig(s: Stub, module: unknown, extra: { sidecars?: Record<string, unknown>; secrets?: Record<string, string>; egress?: { allowHosts: string[]; allowPorts: number[]; allowLoopback: boolean } } = {}) {
  const state: Rig["config"] = { modules: module === undefined ? {} : { [WEB_SEARCH_MODULE]: module }, ...(extra.sidecars ? { sidecars: extra.sidecars } : {}) };
  const traces: SearchTrace[] = [];
  const reads: string[] = [];
  const secrets = extra.secrets ?? KEYS;
  const base = `http://127.0.0.1:${s.port}`;
  const opts: ConfiguredWebSearchOptions = {
    config: () => ({ ...state, egress: extra.egress ?? { allowHosts: ["127.0.0.1"], allowPorts: [s.port], allowLoopback: true } }) as never,
    env: {}, resolver: never, now: () => Date.parse("2026-10-16T09:00:00Z"),
    readSecret: async (name) => { reads.push(name); return secrets[name] ?? null; },
    endpoints: { brave: `${base}/brave`, tavily: `${base}/tavily`, exa: `${base}/exa` },
    sleep: async () => undefined,
    trace: (e) => traces.push(e),
  };
  return { ws: createConfiguredWebSearch(opts), state, traces, reads, base };
}
const q = { query: "harness memory benchmarks" };
const fails = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code && (!re || re.test(e.message)), `expected ${code}`);
const paths = (s: Stub): string[] => s.hits.map((h) => h.url.split("?")[0]!);

describe("web.search configuration", () => {
  it("without a modules.web-search section the chain is SearXNG alone (the earlier behaviour); with the sidecar off that is no-provider", async () => {
    const s = await vendors();
    const { ws } = rig(s, undefined);
    await fails(ws.search.search(q), "no-provider");
    assert.equal(s.hits.length, 0);
  });
  it("parses providers, per-agent lists and key names; drops and reports what it does not understand", () => {
    const p = parseWebSearchSettings({ providers: ["brave", "bing", "searxng", "brave"], agents: { researcher: { providers: ["exa"] }, "Bad Id": { providers: ["exa"] }, quiet: { providers: [] }, broken: {} }, keys: { brave: "my/brave key", tavily: "team.tavily", nope: "x" }, timeoutMs: 5, minIntervalMs: { brave: 1000, exa: -1 } });
    assert.deepEqual(p.providers, ["brave", "searxng"]);
    assert.deepEqual(p.agents, { researcher: ["exa"], quiet: [] });
    assert.equal(p.keys.brave, "web-search.brave");
    assert.equal(p.keys.tavily, "team.tavily");
    assert.equal(p.timeoutMs, undefined);
    assert.deepEqual(p.minIntervalMs, { brave: 1000 });
    assert.ok(p.problems.length >= 7, p.problems.join("; "));
    assert.ok(p.problems.every((m) => !m.includes("my/brave key") || m.includes("not a valid secret name")));
  });
  it("chainFor: the agent's own list wins, then the global one, then SearXNG", () => {
    const p = parseWebSearchSettings({ providers: ["tavily"], agents: { a: { providers: ["exa", "brave"] } } });
    assert.deepEqual(chainFor(p, "a"), ["exa", "brave"]);
    assert.deepEqual(chainFor(p, "b"), ["tavily"]);
    assert.deepEqual(chainFor(p, undefined), ["tavily"]);
    assert.deepEqual(chainFor(parseWebSearchSettings(undefined), "a"), ["searxng"]);
  });
  it("a section that is not an object is reported and ignored", () => {
    assert.deepEqual(parseWebSearchSettings("brave").providers, undefined);
    assert.equal(parseWebSearchSettings("brave").problems.length, 1);
  });
});

describe("web.search with keyed providers", () => {
  for (const id of ["brave", "tavily", "exa"] as const) {
    it(`${id}: returns normalised results, names the provider and sends the key in a header only`, async () => {
      const s = await vendors();
      const { ws } = rig(s, { providers: [id] });
      const out = await ws.search.search(q);
      assert.equal(out.provider, id);
      assert.equal(out.provenance.provider, id);
      assert.equal(out.results[0]!.source, "docs.example.org");
      assert.equal(out.results.length, 2);
      const hit = s.hits[0]!;
      assert.ok(!hit.url.includes(KEYS[`web-search.${id}`]!));
      const header = { brave: hit.headers["x-subscription-token"], tavily: String(hit.headers.authorization).replace("Bearer ", ""), exa: hit.headers["x-api-key"] }[id];
      assert.equal(header, KEYS[`web-search.${id}`]);
    });
  }
  it("no key stored: no-provider, and the API is not called", async () => {
    const s = await vendors();
    const { ws } = rig(s, { providers: ["brave", "exa"] }, { secrets: {} });
    await fails(ws.search.search(q), "no-provider", /brave, exa have no API key/);
    assert.equal(s.hits.length, 0);
  });
  it("a configured secret name is used instead of the default", async () => {
    const s = await vendors();
    const { ws, reads } = rig(s, { providers: ["brave"], keys: { brave: "team.brave-prod" } }, { secrets: { "team.brave-prod": "custom_key_value_1" } });
    await ws.search.search(q);
    assert.deepEqual(reads, ["team.brave-prod"]);
    assert.equal(s.hits[0]!.headers["x-subscription-token"], "custom_key_value_1");
  });
  it("falls back in the configured order and reports the skipped provider by id and reason only", async () => {
    const s = await vendors({ "/brave": (_q, res) => send(res, "{}", 503) });
    const { ws, traces } = rig(s, { providers: ["brave", "tavily"] });
    const out = await ws.search.search(q);
    assert.equal(out.provider, "tavily");
    assert.deepEqual(out.skipped, [{ provider: "brave", reason: "error" }]);
    assert.deepEqual(paths(s), ["/brave", "/tavily"]);
    assert.equal(traces.at(-1)!.provider, "tavily");
    assert.equal(traces.at(-1)!.queryChars, q.query.length);
  });
  it("a provider without a key is skipped for the next one", async () => {
    const s = await vendors();
    const { ws } = rig(s, { providers: ["brave", "exa"] }, { secrets: { "web-search.exa": KEYS["web-search.exa"]! } });
    const out = await ws.search.search(q);
    assert.equal(out.provider, "exa");
    assert.deepEqual(paths(s), ["/exa"]);
  });
  it("one failing provider surfaces its own typed failure; several give provider-failed with codes and the shortest wait", async () => {
    const s = await vendors({ "/brave": (_q, res) => send(res, "{}", 401), "/tavily": (_q, res) => send(res, "{}", 429, { "retry-after": "40" }), "/exa": (_q, res) => send(res, "{}", 429, { "retry-after": "25" }) });
    await fails(rig(s, { providers: ["brave"] }).ws.search.search(q), "http-error", /rejected the API key/);
    const rl = await rig(s, { providers: ["tavily"] }).ws.search.search(q).catch((e: unknown) => e);
    assert.ok(rl instanceof WebFailure && rl.code === "rate-limited" && rl.extra.retryAfterSeconds === 40);
    const many = await rig(s, { providers: ["tavily", "exa"] }).ws.search.search(q).catch((e: unknown) => e);
    assert.ok(many instanceof WebFailure);
    assert.equal(many.code, "provider-failed");
    assert.match(many.message, /tavily: rate-limited, exa: rate-limited/);
    assert.equal(many.extra.retryAfterSeconds, 25);
  });
  it("a 429 starts a cooldown: the next search does not reach the API", async () => {
    const s = await vendors({ "/exa": (_q, res) => send(res, "{}", 429, { "retry-after": "60" }) });
    const { ws } = rig(s, { providers: ["exa"] });
    await fails(ws.search.search(q), "rate-limited");
    await fails(ws.search.search(q), "rate-limited");
    assert.equal(s.hits.length, 1);
    const st = await ws.providers();
    assert.ok(st.providers.find((p) => p.id === "exa")!.coolingSeconds > 0);
  });
  it("enabled: false switches search off", async () => {
    const s = await vendors();
    await fails(rig(s, { enabled: false, providers: ["brave"] }).ws.search.search(q), "no-provider");
    assert.equal(s.hits.length, 0);
  });
});

describe("web.search per agent (D95)", () => {
  const module = { providers: ["brave"], agents: { researcher: { providers: ["exa", "tavily"] }, quiet: { providers: [] } } };
  it("each agent uses its own provider list, others the global one", async () => {
    const s = await vendors();
    const { ws } = rig(s, module);
    assert.equal((await ws.search.search(q, { agentId: "researcher" })).provider, "exa");
    assert.equal((await ws.search.search(q, { agentId: "someone-else" })).provider, "brave");
    assert.equal((await ws.search.search(q)).provider, "brave");
    assert.deepEqual(paths(s), ["/exa", "/brave", "/brave"]);
  });
  it("an agent with an empty list has no search: no-provider", async () => {
    const s = await vendors();
    await fails(rig(s, module).ws.search.search(q, { agentId: "quiet" }), "no-provider");
    assert.equal(s.hits.length, 0);
  });
  it("the chain chosen for a session stays for that session; a new session picks up the change (ADR-010 R4)", async () => {
    const s = await vendors();
    const { ws, state } = rig(s, module);
    assert.equal((await ws.search.search(q, { agentId: "researcher", sessionId: "s1" })).provider, "exa");
    state.modules = { [WEB_SEARCH_MODULE]: { ...module, agents: { researcher: { providers: ["tavily"] } } } };
    assert.equal((await ws.search.search(q, { agentId: "researcher", sessionId: "s1" })).provider, "exa");
    assert.equal((await ws.search.search(q, { agentId: "researcher", sessionId: "s2" })).provider, "tavily");
    assert.equal((await ws.search.search(q, { agentId: "researcher" })).provider, "tavily"); // no session: resolved per call
  });
});

describe("web.search with SearXNG next to the keyed providers", () => {
  it("SearXNG first, a keyed provider as fallback when the sidecar fails", async () => {
    const s = await vendors({ "/search": (_q, res) => send(res, "{}", 500) });
    const { ws } = rig(s, { providers: ["searxng", "brave"] }, { sidecars: { searxng: { mode: "remote", url: `http://127.0.0.1:${s.port}`, timeoutMs: 5000 } } });
    const out = await ws.search.search(q);
    assert.equal(out.provider, "brave");
    assert.deepEqual(out.skipped, [{ provider: "searxng", reason: "error" }]);
    assert.equal((await ws.status()).state, "error");
  });
  it("SearXNG answers when it is first and healthy", async () => {
    const s = await vendors();
    const { ws } = rig(s, { providers: ["searxng", "brave"] }, { sidecars: { searxng: { mode: "remote", url: `http://127.0.0.1:${s.port}`, timeoutMs: 5000 } } });
    const out = await ws.search.search(q);
    assert.equal(out.provider, "searxng");
    assert.equal(out.results[0]!.title, "From SearXNG");
    assert.deepEqual(paths(s), ["/search"]);
  });
  it("a sidecar that is off is left out of the chain, not an error: the keyed provider answers", async () => {
    const s = await vendors();
    const { ws } = rig(s, { providers: ["searxng", "tavily"] });
    const out = await ws.search.search(q);
    assert.equal(out.provider, "tavily");
    assert.deepEqual(out.skipped, []);
  });
  it("a lone SearXNG failure keeps its own cause (as before the router)", async () => {
    const s = await vendors({ "/search": (_q, res) => send(res, "{}", 403) });
    const { ws } = rig(s, undefined, { sidecars: { searxng: { mode: "remote", url: `http://127.0.0.1:${s.port}`, timeoutMs: 5000 } } });
    await fails(ws.search.search(q), "http-error", /json/i);
  });
});

describe("web.search egress and secrets", () => {
  it("a keyed provider needs its host in egress.allowHosts; the refusal is egress-denied and holds no key", async () => {
    const s = await vendors();
    const { ws } = rig(s, { providers: ["brave"] }, { egress: { allowHosts: [], allowPorts: [s.port], allowLoopback: true } });
    const e = await ws.search.search(q).catch((x: unknown) => x);
    assert.ok(e instanceof WebFailure && e.code === "egress-denied");
    assert.ok(!JSON.stringify(e.toResult()).includes(KEYS["web-search.brave"]!));
    assert.equal(s.hits.length, 0);
  });
  it("the key is read per call, so a rotation applies at once", async () => {
    const s = await vendors();
    const secrets = { ...KEYS };
    const { ws } = rig(s, { providers: ["brave"] }, { secrets });
    await ws.search.search(q);
    secrets["web-search.brave"] = "rotated_key_value_7";
    await ws.search.search(q);
    assert.equal(s.hits[1]!.headers["x-subscription-token"], "rotated_key_value_7");
  });
  it("a vendor that echoes the key in its error body leaks it nowhere: not in the failure, hints, skipped list or traces", async () => {
    const key = KEYS["web-search.brave"]!;
    const s = await vendors({ "/brave": (req, res) => send(res, JSON.stringify({ error: `invalid token ${req.headers["x-subscription-token"]}` }), 401) });
    const { ws, traces } = rig(s, { providers: ["brave", "tavily"] });
    const out = await ws.search.search(q);
    assert.ok(!JSON.stringify([out, traces]).includes(key));
    const only = rig(s, { providers: ["brave"] });
    const e = await only.ws.search.search(q).catch((x: unknown) => x);
    assert.ok(e instanceof WebFailure);
    assert.ok(!JSON.stringify([e.toResult(), e.message, only.traces]).includes(key));
  });
  it("providers() lists the state without any key", async () => {
    const s = await vendors();
    const { ws } = rig(s, { providers: ["brave", "bing"] }, { secrets: { "web-search.brave": KEYS["web-search.brave"]! } });
    const st = await ws.providers();
    assert.deepEqual(st.providers.map((p) => [p.id, p.selected, p.configured]), [["searxng", false, false], ["brave", true, true], ["tavily", false, false], ["exa", false, false]]);
    assert.ok(st.problems.some((m) => m.includes("bing")));
    assert.ok(!JSON.stringify(st).includes(KEYS["web-search.brave"]!));
  });
});
