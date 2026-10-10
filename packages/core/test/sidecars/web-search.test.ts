// web.search over the SearXNG sidecar: target resolution (bundled vs remote vs off), the fake SearXNG JSON API, the
// failure paths and the dedicated sidecar egress rules. Everything runs against a loopback stub; nothing leaves the host.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSearxngWebSearch, resolveSearxngTarget, BUNDLED_SEARXNG_ENV, SEARXNG_MODE_ENV, type SidecarsConfig } from "../../src/sidecars/web-search.ts";
import { WebFailure } from "../../src/tools/web/failure.ts";
import { stubResolver, never } from "../tools/web/helpers.ts";

interface Fake { port: number; urls: string[]; headers: http.IncomingHttpHeaders[]; close(): Promise<void> }
const open: Fake[] = [];
async function fakeSearxng(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Fake> {
  const urls: string[] = []; const headers: http.IncomingHttpHeaders[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => { urls.push(req.url ?? ""); headers.push(req.headers); handler(req, res); });
  server.on("connection", (s) => { s.setNoDelay(true); sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: Fake = { port: (server.address() as AddressInfo).port, urls, headers, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
  open.push(fake);
  return fake;
}
afterEach(async () => { await Promise.all(open.splice(0).map((f) => f.close())); });

const json = (res: http.ServerResponse, body: unknown, status = 200, type = "application/json; charset=utf-8"): void => {
  res.writeHead(status, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const remote = (port: number, extra: Record<string, unknown> = {}): SidecarsConfig => ({ searxng: { mode: "remote", url: `http://127.0.0.1:${port}`, timeoutMs: 5000, ...extra } });
const mk = (sidecars: SidecarsConfig | undefined, env: NodeJS.ProcessEnv = {}, extra: Partial<Parameters<typeof createSearxngWebSearch>[0]> = {}) =>
  createSearxngWebSearch({ config: () => sidecars, env, resolver: never, now: () => Date.parse("2026-10-10T08:00:00Z"), ...extra });
const fails = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code && (!re || re.test(e.message)), `expected ${code}`);

describe("web.search over SearXNG: target resolution", () => {
  it("remote mode uses sidecars.searxng.url, not the bundled environment variable", () => {
    const t = resolveSearxngTarget({ searxng: { mode: "remote", url: "http://100.64.0.7:8080" } }, { [BUNDLED_SEARXNG_ENV]: "http://10.0.0.9:8080" });
    assert.equal(t.mode, "remote");
    assert.equal(t.endpoint?.href, "http://100.64.0.7:8080/");
  });
  it("bundled mode takes the address the container layer injected", () => {
    const t = resolveSearxngTarget({ searxng: { mode: "bundled" } }, { [BUNDLED_SEARXNG_ENV]: "http://192.168.64.5:8080" });
    assert.equal(t.mode, "bundled");
    assert.equal(t.endpoint?.href, "http://192.168.64.5:8080/");
  });
  it("bundled without an injected address means the sidecar is not running", () => {
    const t = resolveSearxngTarget({ searxng: { mode: "bundled" } }, {});
    assert.equal(t.endpoint, null);
    assert.match(t.problem ?? "", /not running/i);
  });
  it("inside a container the layer's environment supplies mode and URL where the config has no sidecars entry", () => {
    const bundled = resolveSearxngTarget(undefined, { [SEARXNG_MODE_ENV]: "bundled", [BUNDLED_SEARXNG_ENV]: "http://192.168.64.5:8080" });
    assert.equal(bundled.mode, "bundled"); assert.equal(bundled.endpoint?.host, "192.168.64.5:8080");
    const remote = resolveSearxngTarget({}, { [SEARXNG_MODE_ENV]: "remote", [BUNDLED_SEARXNG_ENV]: "http://100.64.0.7:8080" });
    assert.equal(remote.mode, "remote"); assert.equal(remote.endpoint?.host, "100.64.0.7:8080");
    assert.equal(resolveSearxngTarget(undefined, { [BUNDLED_SEARXNG_ENV]: "http://192.168.64.5:8080" }).mode, "off"); // a URL without a mode wires nothing
    assert.equal(resolveSearxngTarget(undefined, { [SEARXNG_MODE_ENV]: "nonsense", [BUNDLED_SEARXNG_ENV]: "http://10.0.0.1:1" }).mode, "off");
  });
  it("an explicit config entry beats the environment, and config off turns the injected sidecar off", () => {
    const env = { [SEARXNG_MODE_ENV]: "bundled", [BUNDLED_SEARXNG_ENV]: "http://192.168.64.5:8080" };
    assert.equal(resolveSearxngTarget({ searxng: { mode: "off" } }, env).endpoint, null);
    const t = resolveSearxngTarget({ searxng: { mode: "remote", url: "http://100.64.0.7:8080" } }, env);
    assert.equal(t.mode, "remote"); assert.equal(t.endpoint?.host, "100.64.0.7:8080");
  });
  it("off, missing and bad URLs never produce an endpoint", () => {
    assert.equal(resolveSearxngTarget(undefined, {}).mode, "off");
    assert.equal(resolveSearxngTarget({ searxng: { mode: "off", url: "http://10.0.0.1:1" } }, {}).endpoint, null);
    for (const url of ["ftp://10.0.0.1/", "http://user:pw@10.0.0.1/", "http://10.0.0.1/?q=1", "valkey://10.0.0.1:6379/0", "not a url"]) {
      const t = resolveSearxngTarget({ searxng: { mode: "remote", url } }, {});
      assert.equal(t.endpoint, null, url);
      assert.ok(t.problem, url);
    }
    assert.match(resolveSearxngTarget({ searxng: { mode: "remote" } }, {}).problem ?? "", /url/);
  });
});

describe("web.search over SearXNG: success", () => {
  it("queries the JSON API, normalises results and names the provider", async () => {
    const f = await fakeSearxng((_req, res) => json(res, { results: [
      { title: "<b>Harness</b> docs", url: "https://docs.example/harness", content: "A &amp; B <i>snippet</i>", publishedDate: "2026-09-01T00:00:00" },
      { title: "No scheme", url: "javascript:alert(1)", content: "x" },
      { title: "Second", url: "https://two.example/p", content: "y" },
    ] }));
    const s = mk(remote(f.port));
    const out = await s.search.search({ query: "plur1bus harness", count: 5, lang: "de", freshness: "week", site: "docs.example" });
    assert.equal(out.provider, "searxng");
    assert.equal(out.results.length, 1); // site filter drops two.example, scheme filter drops javascript:
    assert.deepEqual(out.results[0], { title: "Harness docs", url: "https://docs.example/harness", snippet: "A & B snippet", publishedAt: "2026-09-01T00:00:00.000Z", source: "docs.example" });
    assert.equal(out.provenance.trust, "untrusted");
    const u = new URL(f.urls[0]!, "http://x");
    assert.equal(u.pathname, "/search");
    assert.equal(u.searchParams.get("format"), "json");
    assert.equal(u.searchParams.get("q"), "plur1bus harness site:docs.example");
    assert.equal(u.searchParams.get("language"), "de");
    assert.equal(u.searchParams.get("time_range"), "month");
    assert.equal(f.headers[0]!.cookie, undefined);
    assert.equal(f.headers[0]!.authorization, undefined);
  });
  it("keeps a path prefix of the configured URL (reverse proxy)", async () => {
    const f = await fakeSearxng((_req, res) => json(res, { results: [] }));
    await mk({ searxng: { mode: "remote", url: `http://127.0.0.1:${f.port}/searx/`, timeoutMs: 5000 } }).search.search({ query: "q" });
    assert.equal(new URL(f.urls[0]!, "http://x").pathname, "/searx/search");
  });
  it("reads the endpoint from the live config on every call", async () => {
    const a = await fakeSearxng((_req, res) => json(res, { results: [{ title: "A", url: "https://a.example/", content: "" }] }));
    const b = await fakeSearxng((_req, res) => json(res, { results: [{ title: "B", url: "https://b.example/", content: "" }] }));
    let cfg = remote(a.port);
    const s = createSearxngWebSearch({ config: () => cfg, env: {}, resolver: never });
    assert.equal((await s.search.search({ query: "q" })).results[0]!.title, "A");
    cfg = remote(b.port);
    assert.equal((await s.search.search({ query: "q" })).results[0]!.title, "B");
  });
  it("resolves a host name through the injected resolver and pins the connection to the vetted address", async () => {
    const f = await fakeSearxng((_req, res) => json(res, { results: [{ title: "T", url: "https://t.example/", content: "" }] }));
    const resolver = stubResolver({ "search.tailnet.ts.net": ["127.0.0.1"] });
    const s = mk({ searxng: { mode: "remote", url: `http://search.tailnet.ts.net:${f.port}`, timeoutMs: 5000 } }, {}, { resolver });
    assert.equal((await s.search.search({ query: "q" })).results.length, 1);
    assert.deepEqual(resolver.calls, ["search.tailnet.ts.net"]);
  });
});

describe("web.search over SearXNG: failures", () => {
  it("off: a clear no-provider error, no connection attempt", async () => {
    await fails(mk({ searxng: { mode: "off" } }).search.search({ query: "q" }), "no-provider", /sidecars\.searxng/);
    await fails(mk(undefined).search.search({ query: "q" }), "no-provider");
  });
  it("bundled but not running: an understandable error instead of a hang", async () => {
    const s = mk({ searxng: { mode: "bundled" } });
    const t0 = Date.now();
    await fails(s.search.search({ query: "q" }), "provider-failed", /not running/i);
    assert.ok(Date.now() - t0 < 500);
    assert.equal(s.status().state, "not-running");
  });
  it("a refused connection reports unreachable", async () => {
    const f = await fakeSearxng(() => undefined); const port = f.port; await f.close();
    const s = mk(remote(port));
    await fails(s.search.search({ query: "q" }), "network-error", /unreachable|reach/i);
    assert.equal(s.status().state, "unreachable");
  });
  it("a slow sidecar times out", async () => {
    const f = await fakeSearxng(() => undefined); // never answers
    const s = mk(remote(f.port), {}, { timeoutMs: 150 });
    const t0 = Date.now();
    await fails(s.search.search({ query: "q" }), "timeout");
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(s.status().state, "unreachable");
  });
  it("maps HTTP errors: 403 means JSON is disabled, 429 rate-limited, 5xx http-error", async () => {
    let status = 403;
    const f = await fakeSearxng((_req, res) => json(res, "denied", status, "text/html"));
    const s = mk(remote(f.port));
    await fails(s.search.search({ query: "q" }), "http-error", /search\.formats|json/i);
    status = 429; await fails(s.search.search({ query: "q" }), "rate-limited");
    status = 502; await fails(s.search.search({ query: "q" }), "http-error", /502/);
    assert.equal(s.status().state, "error");
  });
  it("refuses an oversized response", async () => {
    const f = await fakeSearxng((_req, res) => json(res, { results: [{ title: "T", url: "https://t.example/", content: "x".repeat(300_000) }] }));
    await fails(mk(remote(f.port), {}, { maxBytes: 50_000 }).search.search({ query: "q" }), "too-large");
  });
  it("refuses a non-JSON answer and malformed JSON", async () => {
    let body: string = "<html>login</html>"; let type = "text/html";
    const f = await fakeSearxng((_req, res) => json(res, body, 200, type));
    const s = mk(remote(f.port));
    await fails(s.search.search({ query: "q" }), "unsupported-type");
    body = "{not json"; type = "application/json";
    await fails(s.search.search({ query: "q" }), "http-error", /invalid/i);
    body = JSON.stringify({ nope: true });
    await fails(s.search.search({ query: "q" }), "http-error", /invalid/i);
  });
  it("invalid arguments are rejected before any request", async () => {
    const f = await fakeSearxng((_req, res) => json(res, { results: [] }));
    await fails(mk(remote(f.port)).search.search({ query: "" }), "invalid-arguments");
    assert.equal(f.urls.length, 0);
  });
  it("a certificate fingerprint pin is refused rather than silently ignored", async () => {
    const s = mk({ searxng: { mode: "remote", url: "https://10.0.0.5:8443", fingerprint: `sha256:${"a".repeat(64)}`, timeoutMs: 5000 } });
    await fails(s.search.search({ query: "q" }), "tls-error", /fingerprint/);
  });
});

describe("web.search over SearXNG: egress", () => {
  it("never follows a redirect, so a sidecar cannot bounce the core to another target", async () => {
    const f = await fakeSearxng((_req, res) => { res.writeHead(302, { location: "http://127.0.0.1:1/steal" }); res.end(); });
    await fails(mk(remote(f.port)).search.search({ query: "q" }), "http-error", /redirect/);
    assert.equal(f.urls.length, 1);
  });
  it("refuses metadata and link-local targets even when they are configured", async () => {
    for (const url of ["http://169.254.169.254/", "http://[fe80::1]:8080/", "http://100.100.100.200/", "http://0.0.0.0:8080/"]) {
      const s = mk({ searxng: { mode: "remote", url, timeoutMs: 5000 } });
      await fails(s.search.search({ query: "q" }), "private-address");
    }
  });
  it("the sidecar slot only reaches private or tailnet addresses: a public IP literal or a name resolving to one is refused", async () => {
    await fails(mk({ searxng: { mode: "remote", url: "http://93.184.216.34:8080", timeoutMs: 5000 } }).search.search({ query: "q" }), "private-address");
    const resolver = stubResolver({ "s.example.com": ["93.184.216.34"] });
    await fails(mk({ searxng: { mode: "remote", url: "https://s.example.com", timeoutMs: 5000 } }, {}, { resolver }).search.search({ query: "q" }), "private-address");
  });
  it("a name that mixes a private and a link-local record is refused", async () => {
    const resolver = stubResolver({ "mix.tailnet.ts.net": ["100.64.0.2", "169.254.169.254"] });
    await fails(mk({ searxng: { mode: "remote", url: "http://mix.tailnet.ts.net:8080", timeoutMs: 5000 } }, {}, { resolver }).search.search({ query: "q" }), "private-address");
  });
});

describe("web.search over SearXNG: privacy", () => {
  it("the trace and the status carry lengths, counts and durations but never the query or the results", async () => {
    const f = await fakeSearxng((_req, res) => json(res, { results: [{ title: "Secret result", url: "https://r.example/", content: "secret snippet" }] }));
    const traces: unknown[] = [];
    let t = 0;
    const s = mk(remote(f.port), {}, { trace: (e) => traces.push(e), now: () => (t += 7) });
    await s.search.search({ query: "my private medical question" });
    const blob = JSON.stringify([traces, s.status()]);
    assert.ok(!/medical|Secret result|secret snippet|r\.example/.test(blob), blob);
    assert.equal((traces[0] as { queryChars: number }).queryChars, "my private medical question".length);
    assert.equal((traces[0] as { results: number }).results, 1);
    assert.equal(s.status().state, "ok");
  });
  it("error messages do not echo the query", async () => {
    const f = await fakeSearxng((_req, res) => json(res, "boom", 500, "text/plain"));
    await assert.rejects(mk(remote(f.port)).search.search({ query: "my private medical question" }), (e: unknown) => e instanceof WebFailure && !/medical/.test(JSON.stringify(e.toResult())));
  });
});

describe("web.search over SearXNG: status", () => {
  it("reports mode and configuration without probing", () => {
    assert.deepEqual(mk(undefined).status(), { provider: "searxng", mode: "off", state: "off", endpoint: null });
    const s = mk({ searxng: { mode: "remote", url: "http://100.64.0.7:8080", timeoutMs: 5000 } }).status();
    assert.equal(s.mode, "remote"); assert.equal(s.state, "unknown"); assert.equal(s.endpoint, "http://100.64.0.7:8080");
    assert.equal(mk({ searxng: { mode: "bundled" } }).status().state, "not-running");
    assert.equal(mk({ searxng: { mode: "bundled" } }, { [BUNDLED_SEARXNG_ENV]: "http://192.168.64.5:8080" }).status().state, "unknown");
  });
});
