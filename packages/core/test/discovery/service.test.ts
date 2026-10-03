import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createDiscoveryService } from "../../src/discovery/service.ts";
import { createCatalogStore } from "../../src/discovery/catalog-store.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { FakeClock, InMemoryProfileSource, RecordingEvents, StaticCredentialResolver } from "../../src/discovery/testing.ts";
import { startFakeEndpoint } from "../helpers/fake-endpoint.ts";
import type { FakeEndpoint, FakeReply, FakeRequest } from "../helpers/fake-endpoint.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import type { ProfileInfo } from "../../src/discovery/ports.ts";
import type { ModelsChanged, ScanRequest } from "../../src/discovery/service.ts";

const table = loadMetadataTable();
const opened: FakeEndpoint[] = [];
async function fake(h: (r: FakeRequest) => FakeReply): Promise<FakeEndpoint> {
  const f = await startFakeEndpoint(h);
  opened.push(f);
  return f;
}
after(async () => {
  await Promise.all(opened.map((f) => f.close()));
});

function setup(opts: {
  profiles?: ProfileInfo[];
  credentials?: Record<string, { origin: string; headerName: string; headerValue: string } | "renew_sign_in" | null>;
  enabled?: boolean;
  intervalHours?: number;
  hooks?: { beforeRename?: () => void };
} = {}) {
  const dir = tempDir("p1b-srv-");
  const path = join(dir, "catalog", "models.json");
  const clock = new FakeClock(1_700_000_000_000);
  const loggerLines: string[] = [];
  const log = {
    debug(m: string, f?: object) { loggerLines.push(JSON.stringify({ lvl: "debug", m, ...f })); },
    info(m: string, f?: object) { loggerLines.push(JSON.stringify({ lvl: "info", m, ...f })); },
    warn(m: string, f?: object) { loggerLines.push(JSON.stringify({ lvl: "warn", m, ...f })); },
    error(m: string, f?: object) { loggerLines.push(JSON.stringify({ lvl: "error", m, ...f })); },
  };
  const store = createCatalogStore({
    path,
    tableRevision: table.revision,
    clock,
    securePath: () => {},
    logger: log,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  });
  store.load();

  const profileSource = new InMemoryProfileSource(opts.profiles ?? []);
  const credentialResolver = new StaticCredentialResolver(opts.credentials ?? {});
  const events = new RecordingEvents();
  const rng = () => 0.5; // deterministic no-jitter

  let enabled = opts.enabled ?? true;
  let intervalHours = opts.intervalHours ?? 24;
  let currentRoles: Record<string, string> = {};

  const service = createDiscoveryService({
    store,
    profiles: profileSource,
    credentials: credentialResolver,
    events,
    clock,
    rng,
    table,
    roles: () => currentRoles,
    settings: () => ({ enabled, intervalHours }),
    logger: log,
    maxParallel: 4,
  });

  return {
    dir,
    path,
    clock,
    store,
    profileSource,
    events,
    loggerLines,
    service,
    setEnabled: (v: boolean) => { enabled = v; },
    setIntervalHours: (v: number) => { intervalHours = v; },
    setRoles: (r: Record<string, string>) => { currentRoles = r; },
  };
}

describe("discovery service", () => {
  it("an ok scan stores models, emits one discovered event and sets state", async () => {
    const f = await fake(() => ({
      json: { data: [{ id: "example-chat-large" }, { id: "example-embed-small" }] },
    }));
    const s = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f.origin}/v1`, vendor: "example-vendor" }],
      credentials: { p: { origin: f.origin, headerName: "authorization", headerValue: "Bearer K" } },
    });
    s.setRoles({ chat: "p/example-chat-large" });

    const res = await s.service.scanProvider("p", { trigger: "cron" });
    assert.equal(res.result, "ok");
    assert.deepEqual(res.new, ["example-chat-large", "example-embed-small"]);

    assert.equal(s.events.log.length, 2);
    assert.equal(s.events.log[0]!.name, "discovered");
    assert.equal(s.events.log[1]!.name, "completed");

    const cat = s.store.read();
    assert.equal(cat.providers.p?.lastResult, "ok");
    assert.ok(cat.providers.p?.lastScanAt);
    assert.ok(cat.providers.p?.nextScanAt);

    // +/-10% of 24 h
    const nextMs = Date.parse(cat.providers.p!.nextScanAt!);
    const expectedMs = s.clock.now() + 24 * 3600_000;
    assert.ok(Math.abs(nextMs - expectedMs) <= 0.1 * 24 * 3600_000);
  });

  it("a mid-pagination failure reconciles nothing", async () => {
    let page = 0;
    const f = await fake(() => {
      page++;
      if (page === 1) return { json: { data: [{ id: "m1" }], has_more: true, last_id: "m1" } };
      return { status: 500 };
    });
    const s = setup({
      profiles: [{ id: "p", discovery: "anthropic-models", baseUrl: `${f.origin}/v1` }],
      credentials: { p: { origin: f.origin, headerName: "authorization", headerValue: "Bearer K" } },
    });

    const beforeJson = JSON.stringify(s.store.read());
    const res = await s.service.scanProvider("p", { trigger: "cron" });
    assert.equal(res.result, "failed:server");

    const cat = s.store.read();
    assert.equal(cat.models.length, 0);
    assert.equal(cat.providers.p?.lastResult, "failed:server");
    assert.ok(cat.providers.p?.nextScanAt);
    assert.equal(s.events.log.some((e) => e.name === "discovered"), false);
  });

  it("an empty list is failed:empty and changes no entry", async () => {
    const f = await fake(() => ({ json: { data: [] } }));
    const s = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f.origin}/v1` }],
      credentials: { p: null },
    });

    const res = await s.service.scanProvider("p", { trigger: "cron" });
    assert.equal(res.result, "failed:empty");
    assert.equal(res.error?.reason, "empty_list");

    const cat = s.store.read();
    assert.equal(cat.providers.p?.lastScanAt, undefined);
    assert.equal(cat.providers.p?.lastResult, "failed:empty");
    assert.ok(s.events.log.some((e) => e.name === "failed"));
  });

  it("error table", async () => {
    // 401
    const f401 = await fake(() => ({ status: 401 }));
    const s401 = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f401.origin}/v1` }],
      credentials: { p: { origin: f401.origin, headerName: "authorization", headerValue: "Bearer K" } },
    });
    const r401 = await s401.service.scanProvider("p", { trigger: "cron" });
    assert.equal(r401.result, "failed:auth");
    assert.ok(r401.error?.hint.includes("plur1bus login p"));
    assert.equal(s401.store.read().providers.p?.consecutiveFailures, undefined);

    // 503
    const f503 = await fake(() => ({ status: 503 }));
    const s503 = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f503.origin}/v1` }],
      credentials: { p: null },
    });
    const r503 = await s503.service.scanProvider("p", { trigger: "cron" });
    assert.equal(r503.result, "failed:server");
    assert.equal(s503.store.read().providers.p?.consecutiveFailures, 1);
    const next503 = Date.parse(s503.store.read().providers.p!.nextScanAt!);
    assert.ok(Math.abs(next503 - (s503.clock.now() + 300_000)) <= 30_000);

    // 429 + Retry-After
    const f429 = await fake(() => ({ status: 429, headers: { "Retry-After": "7200" } }));
    const s429 = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f429.origin}/v1` }],
      credentials: { p: null },
    });
    const r429 = await s429.service.scanProvider("p", { trigger: "cron" });
    assert.equal(r429.result, "failed:server");
    const next429 = Date.parse(s429.store.read().providers.p!.nextScanAt!);
    assert.equal(next429, s429.clock.now() + 7200 * 1000);

    // non-JSON
    const fHtml = await fake(() => ({ body: Buffer.from("<html>"), headers: { "Content-Type": "text/html" } }));
    const sHtml = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${fHtml.origin}/v1` }],
      credentials: { p: null },
    });
    const rHtml = await sHtml.service.scanProvider("p", { trigger: "cron" });
    assert.equal(rHtml.result, "failed:invalid");

    // refused credential
    const sRenew = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: "http://127.0.0.1:1/v1" }],
      credentials: { p: "renew_sign_in" },
    });
    const rRenew = await sRenew.service.scanProvider("p", { trigger: "cron" });
    assert.equal(rRenew.result, "failed:auth");
    assert.equal(rRenew.error?.reason, "renew_sign_in");
  });

  it("a manual scan resets the failure counter", async () => {
    const f503 = await fake(() => ({ status: 503 }));
    const s = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f503.origin}/v1` }],
      credentials: { p: null },
    });

    await s.service.scanProvider("p", { trigger: "cron" });
    await s.service.scanProvider("p", { trigger: "cron" });
    await s.service.scanProvider("p", { trigger: "cron" });
    assert.equal(s.store.read().providers.p?.consecutiveFailures, 3);

    // manual scan failing again: resets counter first, so it becomes 1
    await s.service.scanProvider("p", { trigger: "manual" });
    assert.equal(s.store.read().providers.p?.consecutiveFailures, 1);
  });

  it("a failed catalog write advances no state and emits no event", async () => {
    let fail = true;
    const f = await fake(() => ({ json: { data: [{ id: "m1" }] } }));
    const s = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f.origin}/v1` }],
      credentials: { p: null },
      hooks: { beforeRename: () => { if (fail) throw new Error("write error"); } },
    });

    const res = await s.service.scanProvider("p", { trigger: "cron" });
    assert.equal(s.events.log.length, 0);
    assert.equal(s.store.read().providers.p?.lastResult, undefined);
    assert.equal(res.nextScanAt, new Date(s.clock.now() + 300_000).toISOString());

    fail = false;
    const res2 = await s.service.scanProvider("p", { trigger: "cron" });
    assert.equal(res2.result, "ok");
    assert.equal(s.store.read().providers.p?.lastResult, "ok");
  });

  it("a second scan of the same provider returns already_running", async () => {
    let resolveStall: () => void;
    const stalled = new Promise<void>((r) => { resolveStall = r; });
    const f = await fake(() => ({ json: { data: [{ id: "m1" }] } }));

    const s = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f.origin}/v1` }],
      credentials: { p: null },
    });

    // Make client stall
    let firstStarted = false;
    const originalMake = undefined;

    const p1 = s.service.scanProvider("p", {
      trigger: "cron",
      runId: "run-1",
    });

    // Second call before first finishes
    const p2 = await s.service.scanProvider("p", {
      trigger: "manual",
      runId: "run-2",
    });

    assert.equal(p2.result, "already_running");
    assert.equal(p2.runningRunId, "run-1");

    await p1;
  });

  it("no-scanner and disabled skips", async () => {
    const f = await fake(() => ({ json: {} }));
    const s = setup({
      profiles: [
        { id: "manual-p", discovery: "manual", baseUrl: `${f.origin}/v1` },
        { id: "auto-p", discovery: "openai-models", baseUrl: `${f.origin}/v1` },
      ],
      credentials: { "manual-p": null, "auto-p": null },
    });

    const res1 = await s.service.scanProvider("manual-p", { trigger: "cron" });
    assert.equal(res1.result, "no-scanner");

    s.setEnabled(false);
    const res2 = await s.service.scanProvider("auto-p", { trigger: "cron" });
    assert.equal(res2.result, "disabled");
    assert.equal(f.requests.length, 0);
  });

  it("models.changed callback fires after the write and only for a change", async () => {
    const f = await fake(() => ({ json: { data: [{ id: "m1" }] } }));
    const s = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f.origin}/v1` }],
      credentials: { p: null },
    });

    const changes: ModelsChanged[] = [];
    s.service.onChanged((e) => changes.push(e));

    await s.service.scanProvider("p", { trigger: "cron" });
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0]!.discovered, ["m1"]);

    // Scan again with same data: unchanged
    await s.service.scanProvider("p", { trigger: "cron" });
    assert.equal(changes.length, 1);
  });

  it("list filters and acknowledge", async () => {
    const f = await fake(() => ({
      json: { data: [{ id: "m1" }, { id: "m2" }] },
    }));
    const s = setup({
      profiles: [{ id: "p", discovery: "openai-models", baseUrl: `${f.origin}/v1` }],
      credentials: { p: null },
    });

    await s.service.scanProvider("p", { trigger: "cron" });

    const l1 = s.service.list({});
    assert.equal(l1.models.length, 2);
    assert.equal(l1.newCount, 2);

    await s.service.acknowledge();
    const l2 = s.service.list({});
    assert.equal(l2.newCount, 0);
  });

  it("canaries reach no output", async () => {
    const f = await fake((r) => {
      if (r.url.includes("401")) return { status: 401, body: Buffer.from("CANARY-KEY-1") };
      if (r.url.includes("500")) return { status: 500, body: Buffer.from("Bearer CANARY-TOKEN-2") };
      if (r.url.includes("302")) return { status: 302, headers: { Location: "https://auth.example.invalid/authorize?code=CANARY-URL-3" } };
      return { status: 200 };
    });

    const s = setup({
      profiles: [
        { id: "p1", discovery: "openai-models", baseUrl: `${f.origin}/v1/401` },
        { id: "p2", discovery: "openai-models", baseUrl: `${f.origin}/v1/500` },
        { id: "p3", discovery: "openai-models", baseUrl: `${f.origin}/v1/302` },
      ],
      credentials: { p1: null, p2: null, p3: null },
    });

    await s.service.scanProvider("p1", { trigger: "cron" });
    await s.service.scanProvider("p2", { trigger: "cron" });
    await s.service.scanProvider("p3", { trigger: "cron" });

    const checkNoCanary = (text: string) => {
      assert.ok(!text.includes("CANARY-KEY-1"), "CANARY-KEY-1 leaked");
      assert.ok(!text.includes("CANARY-TOKEN-2"), "CANARY-TOKEN-2 leaked");
      assert.ok(!text.includes("CANARY-URL-3"), "CANARY-URL-3 leaked");
    };

    checkNoCanary(JSON.stringify(s.events.log));
    checkNoCanary(JSON.stringify(s.loggerLines));
    checkNoCanary(readFileSync(s.path, "utf8"));
  });
});
