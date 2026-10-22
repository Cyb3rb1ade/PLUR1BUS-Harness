// privacy.localOnly (docs/egress.md "Discovery"): a locked (non-local) provider's catalog is never queried, so its API
// key never leaves the machine; local endpoints keep being scanned. The models stay listed, marked locked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createCatalogStore } from "../../src/discovery/catalog-store.ts";
import { createDiscoveryService } from "../../src/discovery/service.ts";
import { createScanScheduler } from "../../src/discovery/scheduler.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { FakeClock, InMemoryProfileSource, RecordingEvents } from "../../src/discovery/testing.ts";
import { isLocalEndpoint } from "../../src/privacy/local-only.ts";
import type { Scanner } from "../../src/discovery/scanners/index.ts";
import type { ProfileInfo } from "../../src/discovery/ports.ts";

const table = loadMetadataTable();
const quiet = { debug() {}, info() {}, warn() {} };
const HOUR = 3_600_000;

const cloud: ProfileInfo = { id: "openai", discovery: "openai-models", baseUrl: "https://api.openai.com/v1" };
const local: ProfileInfo = { id: "ollama", discovery: "ollama-tags", baseUrl: "http://127.0.0.1:11434" };
const lan: ProfileInfo = { id: "lan-vllm", discovery: "openai-models", baseUrl: "https://vllm.home.example:8000/v1" };

function fixture(opts: { localOnly: boolean; listed?: string[] }) {
  const dir = tempDir("p1b-local-only-scan-");
  const clock = new FakeClock(1_700_000_000_000);
  const store = createCatalogStore({ path: join(dir, "models.json"), tableRevision: table.revision, clock, securePath: () => {}, logger: quiet });
  store.load();
  const state = { localOnly: opts.localOnly };
  const requests: string[] = [];
  const credentialLookups: string[] = [];
  const scanner: Scanner = async (profile) => {
    requests.push(profile.id);
    return { entries: [{ id: `${profile.id}-model` }], duplicates: 0, pages: 1 };
  };
  const service = createDiscoveryService({
    store,
    profiles: new InMemoryProfileSource([cloud, local, lan]),
    credentials: { resolve: async (id, origin) => { credentialLookups.push(id); return { origin, headerName: "Authorization", headerValue: "Bearer probe" }; } },
    events: new RecordingEvents(), clock, rng: () => 0.5, table, roles: () => ({}),
    settings: () => ({ enabled: true, intervalHours: 24 }), logger: quiet,
    scanners: { "openai-models": scanner, "ollama-tags": scanner },
    modelLocked: (_provider, profile) => state.localOnly && !(profile !== undefined && isLocalEndpoint(profile.baseUrl, opts.listed ?? [])),
  });
  return { clock, store, service, state, requests, credentialLookups };
}

describe("privacy.localOnly: model discovery does not scan cloud catalogs", () => {
  it("scanAll scans only the local endpoints and never looks up a credential for a cloud provider", async () => {
    const f = fixture({ localOnly: true });
    const results = await f.service.scanAll({ trigger: "manual" });
    assert.deepEqual(results.map((r) => [r.provider, r.result]), [["ollama", "ok"]]);
    assert.deepEqual(f.requests, ["ollama"]);
    assert.deepEqual(f.credentialLookups, ["ollama"]);
    assert.deepEqual(f.service.scannable().map((p) => p.id), ["ollama"]);
  });

  it("a manual scan of one cloud provider is refused as disabled before any request or credential lookup", async () => {
    const f = fixture({ localOnly: true });
    const r = await f.service.scanProvider("openai", { trigger: "manual" });
    assert.equal(r.result, "disabled");
    assert.deepEqual([f.requests, f.credentialLookups], [[], []]);
    assert.equal(f.store.read().providers.openai, undefined, "no scan state is recorded for a scan that did not happen");
  });

  it("a LAN server scans only when it is listed in privacy.localEndpoints", async () => {
    const unlisted = fixture({ localOnly: true });
    await unlisted.service.scanProvider("lan-vllm", { trigger: "manual" });
    assert.deepEqual(unlisted.requests, []);
    const listed = fixture({ localOnly: true, listed: ["https://vllm.home.example:8000"] });
    assert.equal((await listed.service.scanProvider("lan-vllm", { trigger: "manual" })).result, "ok");
    assert.deepEqual(listed.requests, ["lan-vllm"]);
  });

  it("the scheduled scan skips cloud providers under localOnly and resumes after the switch is turned off", async () => {
    const f = fixture({ localOnly: true });
    const scheduler = createScanScheduler({
      service: f.service, store: f.store, clock: f.clock, rng: () => 0.5, logger: { debug() {} },
      settings: () => ({ enabled: true, intervalHours: 24 }),
      systemRun: async (provider, trigger, signal) => { await f.service.scanProvider(provider, { trigger, signal }); },
    });
    scheduler.start();
    await f.clock.advance(26 * HOUR);
    assert.deepEqual(f.requests.includes("openai"), false, "no cloud catalog request while localOnly is on");
    assert.deepEqual(f.credentialLookups.includes("openai"), false);
    assert.ok(f.requests.includes("ollama"), "the local endpoint is still scanned");

    f.state.localOnly = false;
    scheduler.replan();
    await f.clock.advance(26 * HOUR);
    assert.ok(f.requests.includes("openai"), "with the switch off the cloud catalog is scanned again");
    scheduler.stop();
  });

  it("the cloud models stay listed, marked locked, and without the switch every provider is scanned", async () => {
    const f = fixture({ localOnly: false });
    const results = await f.service.scanAll({ trigger: "manual" });
    assert.deepEqual(results.map((r) => r.provider).sort(), ["lan-vllm", "ollama", "openai"]);
    assert.ok(f.service.list({}).models.every((m) => !("locked" in m)));
    f.state.localOnly = true;
    const list = f.service.list({});
    assert.equal(list.models.find((m) => m.provider === "openai")!.locked, "local-only");
    assert.equal("locked" in list.models.find((m) => m.provider === "ollama")!, false);
  });
});
