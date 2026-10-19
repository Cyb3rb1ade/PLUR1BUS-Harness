import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaults } from "@plur1bus/config-schema";
import { createHarnessHost } from "../src/host.ts";
import { createEgress } from "../src/egress/service.ts";
import { createLogger } from "../src/logger.ts";
import { createAgentRegistry } from "../src/agents.ts";
import { layout } from "../src/paths.ts";
import { createSecretStore } from "../src/secrets/store.ts";
import { createMemoryBackend } from "../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../src/secrets/audit.ts";
import { tempDir } from "./helpers/temp-dir.ts";

function fixture(t: { after(fn: () => unknown): void }) {
  const l = layout(tempDir("p1b-engine-ports-")), config = defaults();
  const logger = createLogger({ file: l.logFile("core"), level: "info", role: "core" });
  t.after(() => logger.close());
  const audit = createMemoryAuditSink();
  const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit });
  let allowed = true;
  const egress = createEgress({ config: () => ({ allowHosts: allowed ? ["127.0.0.1", "localhost"] : [], allowPorts: Array.from({ length: 65535 }, (_, i) => i + 1), allowLoopback: allowed }) });
  const host = createHarnessHost({ layout: l, logger, config, engineConfig: {}, agents: createAgentRegistry(config, l), events() {}, egress, secrets });
  return { host, secrets, audit, egress, deny: () => { allowed = false; } };
}

async function server(t: { after(fn: () => unknown): void }, handler: http.RequestListener) {
  const s = http.createServer(handler).listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(() => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

test("engine fetch carries POST credentials and error JSON through live egress; later denial prevents I/O", async t => {
  const f = fixture(t); let hits = 0;
  const url = await server(t, async (req, res) => {
    hits++;
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    let body = ""; for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { input: "memory" });
    res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"rotate"}');
  });
  assert.equal(typeof f.host.fetch, "function");
  const response = await f.host.fetch!(new Request(url, { method: "POST", headers: { authorization: "Bearer fixture-key" }, body: '{"input":"memory"}' }));
  assert.equal(response.status, 401); assert.equal(response.ok, false);
  assert.deepEqual(await response.json(), { error: "rotate" });
  f.deny();
  await assert.rejects(() => f.host.fetch!(url));
  assert.equal(hits, 1);
});

test("engine fetch never forwards a provider body or Authorization across a redirect", async t => {
  const f = fixture(t); let leaked = 0;
  const target = await server(t, (_req, res) => { leaked++; res.end("leaked"); });
  const source = await server(t, (_req, res) => { res.writeHead(307, { location: target }); res.end(); });
  const response = await f.host.fetch!(source, { method: "POST", headers: { authorization: "Bearer private" }, body: "memory" });
  assert.equal(response.status, 307); assert.equal(leaked, 0);
  for (const headers of [{ authorization: "Bearer private" }, { "x-api-key": "private" }]) {
    assert.equal((await f.host.fetch!(source, { headers })).status, 307);
    assert.equal(leaked, 0);
  }
});

test("engine fetch streams downloads, retains URL, honours cancellation and redirect modes", async t => {
  const f = fixture(t);
  const url = await server(t, (req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/model" }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream" }); res.write("first");
    // Keep the body open: fetch must resolve before the download completes.
  });
  const ac = new AbortController();
  const response = await f.host.fetch!(`${url}/redirect`, { signal: ac.signal });
  assert.equal(response.url, `${url}/model`); assert.equal(response.redirected, true);
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  ac.abort(); await assert.rejects(() => reader.read());
  assert.equal((await f.host.fetch!(`${url}/redirect`, { redirect: "manual" })).status, 302);
  await assert.rejects(() => f.host.fetch!(`${url}/redirect`, { redirect: "error" }));
});

test("engine secret resolution uses audited core leases, revokes them and observes rotation/deletion", async t => {
  const f = fixture(t), owner = { kind: "owner" as const };
  await f.secrets.set(owner, "models/key", "first-fixture-value");
  assert.equal(typeof f.host.secrets?.resolve, "function");
  assert.equal(await f.host.secrets!.resolve("models/key", "embedding"), "first-fixture-value");
  assert.equal(f.secrets.activeLeases({ kind: "core" }).length, 0);
  await f.secrets.set(owner, "models/key", "rotated-fixture-value");
  assert.equal(await f.host.secrets!.resolve("models/key", "reranker"), "rotated-fixture-value");
  await f.secrets.delete(owner, "models/key");
  await assert.rejects(() => f.host.secrets!.resolve("models/key", "llm"));
  const audit = JSON.stringify(f.audit.events);
  assert.match(audit, /secret.lease/); assert.match(audit, /embedding/); assert.match(audit, /reranker/);
  assert.ok(!audit.includes("fixture-value"));
});

test("public engine embedding and HTTP reranking use harness secrets and live egress without global fetch", async t => {
  const { bindEngine } = await import("../src/engine.ts");
  const { buildEngineConfig } = await import("../src/engine-config.ts");
  const { mkdirSync } = await import("node:fs");
  const f = fixture(t), seen: { path: string; key: string | undefined; body: any }[] = [];
  const url = await server(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    seen.push({ path: req.url!, key: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/embeddings") res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } }));
    else res.end('[{"index":1,"score":0.9},{"index":0,"score":0.1}]');
  });
  await f.secrets.set({ kind: "owner" }, "models/test", "in-memory-fixture");
  const cfg = defaults();
  cfg.engine.embedding = { provider: "openai-compatible", baseUrl: `${url}/v1`, model: "fixture", dimensions: 3, apiKeyRef: "models/test" };
  cfg.engine.reranker = { provider: "remote", baseUrl: url, protocol: "tei", apiKeyRef: "models/test" };
  const l = layout(tempDir("p1b-engine-http-")); mkdirSync(l.state, { recursive: true });
  const engine = bindEngine(f.host, buildEngineConfig(cfg, l));
  t.after(() => engine.close({ budgetMs: 1000 }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected global fetch"); };
  t.after(() => { globalThis.fetch = original; });
  const identity = engine.embedding.identities()[0]!;
  const vectors = await engine.embedding.embed(["memory"], { kind: "query", identity, signal: new AbortController().signal });
  assert.deepEqual(Array.from(vectors[0]!), [1, 0, 0]);
  const hits = await engine.embedding.rerank("query", ["low", "high"], { topN: 2, signal: new AbortController().signal });
  assert.equal(hits[0]!.index, 1);
  assert.deepEqual(seen.map(s => [s.path, s.key]), [["/v1/embeddings", "Bearer in-memory-fixture"], ["/rerank", "Bearer in-memory-fixture"]]);
  assert.deepEqual(seen[1]!.body, { query: "query", texts: ["low", "high"], raw_scores: false, return_text: false });
  f.deny();
  // Fail-soft reranking may return [], but it must not send another request.
  await engine.embedding.rerank("query", ["low"], { topN: 1, signal: new AbortController().signal }).catch(() => {});
  assert.equal(seen.length, 2);
});

test("streamed egress enforces its decompressed byte cap and deadline after headers", async t => {
  const f = fixture(t);
  const url = await server(t, (_req, res) => { res.writeHead(200); res.write("12345"); });
  const capped = await f.egress.request(url, { userAgent: "test", streamResponse: true, maxBytes: 3, timeoutMs: 1000 });
  await assert.rejects(() => capped.stream!.getReader().read(), (e: any) => e.code === "too-large");
  const timed = await f.egress.request(url, { userAgent: "test", streamResponse: true, timeoutMs: 50 });
  const reader = timed.stream!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "12345");
  await assert.rejects(() => reader.read(), (e: any) => e.code === "timeout");
});

test("aborting a stalled request body rejects fetch and cancels its source before network I/O", async t => {
  const f = fixture(t), ac = new AbortController(); let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } });
  const request = new Request("https://unused.invalid", { method: "POST", body: source, signal: ac.signal, duplex: "half" } as RequestInit & { duplex: string });
  const pending = f.host.fetch!(request).then(() => "resolved", () => "aborted");
  ac.abort();
  let timer: ReturnType<typeof setTimeout>;
  const settled = await Promise.race([pending, new Promise<string>(resolve => { timer = setTimeout(() => resolve("stalled"), 100); })]);
  clearTimeout(timer!);
  assert.equal(settled, "aborted"); assert.equal(cancelled, true);
});

test("standalone probe hosts use the target home's live egress and encrypted secret store", async t => {
  const { createTempHost } = await import("../src/import/importers/hermes-stores.ts");
  const { writeConfigAtomic } = await import("../src/config-load.ts");
  const { createCoreSecretStore } = await import("../src/secrets/runtime.ts");
  const { createPlatformCapabilities } = await import("../src/platform.ts");
  const target = layout(tempDir("p1b-import-port-target-")), probe = layout(tempDir("p1b-import-port-probe-"));
  const cfg = defaults(); cfg.secrets.fileFallback.enabled = true;
  const url = await server(t, (_req, res) => { res.end("guarded"); });
  cfg.egress = { allowHosts: ["127.0.0.1"], allowPorts: [Number(new URL(url).port)], allowLoopback: true };
  writeConfigAtomic(target.configPath, cfg);
  const oldGuard = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, oldKeyring = process.env.PLUR1BUS_SECRETS_KEYRING;
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1"; process.env.PLUR1BUS_SECRETS_KEYRING = "off";
  t.after(() => {
    if (oldGuard === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS; else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = oldGuard;
    if (oldKeyring === undefined) delete process.env.PLUR1BUS_SECRETS_KEYRING; else process.env.PLUR1BUS_SECRETS_KEYRING = oldKeyring;
  });
  const store = createCoreSecretStore({ layout: target, securePath: createPlatformCapabilities().securePath, fileFallback: () => true });
  await store.set({ kind: "owner" }, "models/probe", "target-home-fixture");
  const host = createTempHost(probe.state, async id => probe.workspaceDir(id), target.home);
  assert.equal(await host.secrets!.resolve("models/probe", "embedding"), "target-home-fixture");
  assert.equal(await (await host.fetch!(url)).text(), "guarded");
  cfg.egress.allowHosts = []; writeConfigAtomic(target.configPath, cfg);
  await assert.rejects(() => host.fetch!(url));
});

test("model GET redirect with harmless headers streams a large gzip/chunked response across hosts", async t => {
  const { createGzip } = await import("node:zlib");
  const f = fixture(t); let chunks = 0;
  const cdn = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { "content-encoding": "gzip", "content-type": "application/octet-stream" });
    const gzip = createGzip(); gzip.pipe(res);
    const chunk = Buffer.alloc(1024 * 1024, 7);
    for (let n = 0; n < 21; n++) gzip.write(chunk);
    gzip.end();
  });
  const first = await server(t, (_req, res) => { res.writeHead(302, { location: cdn.replace("127.0.0.1", "localhost") }); res.end(); });
  const response = await f.host.fetch!(first, { headers: { accept: "application/octet-stream", "user-agent": "transformers/test" } });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  for (;;) { const next = await reader.read(); if (next.done) break; chunks += next.value.length; }
  assert.equal(chunks, 21 * 1024 * 1024);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
});
