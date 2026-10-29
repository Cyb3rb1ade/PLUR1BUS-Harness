/** F1 registered fetching uses the live egress service for page, robots and redirect traffic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeTools, ToolAdapterError } from "../../src/composition/tools.ts";
import { createEgress } from "../../src/egress/index.ts";
import { createWebFetch, type WebFetchResult } from "../../src/tools/web/fetch.ts";
import { HostPacer } from "../../src/tools/web/robots.ts";
import { startStub } from "../tools/web/helpers.ts";
import { turnRequest, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs("composed-web-fetch-");
const context = () => ({ signal: new AbortController().signal, agentId: "a1", principal: "owner", sessionId: "s1" });
const options = () => ({
  home: dirs.make(), roots: [], audit: { append() {} }, grants: { get: () => undefined, list: () => [] },
});
const hasCode = (code: string) => (error: unknown) => error instanceof ToolAdapterError
  && typeof error.detail === "object" && error.detail !== null && "error" in error.detail
  && (error.detail.error as { code: string }).code === code;

test("web.fetch is registered without search configuration and refuses an unavailable egress transport", async () => {
  const registry = await composeTools(options(), turnRequest());
  const tool = registry.get("web.fetch");
  assert(tool);
  assert.equal(registry.get("web.search"), undefined);
  assert.equal(tool.capability, "net.fetch");
  assert.equal(tool.effect, "read");
  assert.equal(tool.trust, "first-party");
  await assert.rejects(tool.execute({ url: "https://example.test/" }, context()), hasCode("egress-denied"));
});

test("registered fetch sends robots, page and redirects through the injected egress service", async () => {
  const server = await startStub((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
    } else if (req.url === "/start") {
      res.writeHead(302, { location: "/article" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Evidence from the permitted destination.");
    }
  });
  try {
    const egress = createEgress({
      config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [server.port], allowLoopback: true }),
    });
    const webFetch = createWebFetch({
      request: (url, request) => egress.request(url, request), pacer: new HostPacer({ minIntervalMs: 0 }),
    });
    const registry = await composeTools({ ...options(), webFetch }, turnRequest());
    const result = await registry.get("web.fetch")!.execute({
      url: `http://127.0.0.1:${server.port}/start`, crawl: true,
    }, context()) as WebFetchResult;
    assert.equal(result.markdown, "Evidence from the permitted destination.");
    assert.deepEqual(server.hits.map(hit => hit.url), ["/robots.txt", "/start", "/article"]);
    assert.equal(egress.status().decisions.allowed, 3);
    assert.equal(egress.status().decisions.denied, 0);
  } finally { await server.close(); }
});

test("the live egress policy refuses the registered fetch before DNS or a socket is reached", async () => {
  const server = await startStub((_req, res) => res.end("must not be read"));
  try {
    let resolves = 0;
    let allowed = true;
    const egress = createEgress({
      config: () => ({ allowHosts: allowed ? ["denied.test"] : [], allowPorts: [server.port], allowLoopback: true }),
      resolver: async () => { resolves++; return [{ address: "127.0.0.1", family: 4 }]; },
    });
    const webFetch = createWebFetch({ request: (url, request) => egress.request(url, request) });
    const registry = await composeTools({ ...options(), webFetch }, turnRequest());
    allowed = false;
    await assert.rejects(registry.get("web.fetch")!.execute({
      url: `http://denied.test:${server.port}/private`,
    }, context()), hasCode("egress-denied"));
    assert.equal(resolves, 0);
    assert.equal(server.hits.length, 0);
    assert.equal(egress.status().decisions.denied, 1);
  } finally { await server.close(); }
});

test("a redirect cannot carry the registered fetch outside the egress allowlist", async () => {
  const server = await startStub((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.2:${server.port}/blocked` });
    res.end();
  });
  try {
    const egress = createEgress({
      config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [server.port], allowLoopback: true }),
    });
    const webFetch = createWebFetch({ request: (url, request) => egress.request(url, request) });
    const registry = await composeTools({ ...options(), webFetch }, turnRequest());
    await assert.rejects(registry.get("web.fetch")!.execute({
      url: `http://127.0.0.1:${server.port}/redirect`,
    }, context()), hasCode("egress-denied"));
    assert.deepEqual(server.hits.map(hit => hit.url), ["/redirect"]);
    assert.equal(egress.status().decisions.allowed, 1);
    assert.equal(egress.status().decisions.denied, 1);
  } finally { await server.close(); }
});
