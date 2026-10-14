// Audit b04 (model discovery): service.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createCatalogStore } from "../../src/discovery/catalog-store.ts";
import { createDiscoveryService } from "../../src/discovery/service.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { ScanError } from "../../src/discovery/http.ts";
import { FakeClock, InMemoryProfileSource, RecordingEvents } from "../../src/discovery/testing.ts";
import type { Scanner } from "../../src/discovery/scanners/index.ts";
import type { ProfileInfo } from "../../src/discovery/ports.ts";

const table = loadMetadataTable();
const quiet = { debug() {}, info() {}, warn() {} };

function mkStore(clock = new FakeClock(1_700_000_000_000)) {
  const dir = tempDir("p1b-b04-");
  const store = createCatalogStore({ path: join(dir, "models.json"), tableRevision: table.revision, clock, securePath: () => {}, logger: quiet });
  store.load();
  return { dir, store, clock };
}
function mkService(profiles: ProfileInfo[], scanner: Scanner, events = new RecordingEvents(), maxParallel = 4) {
  const { store, clock } = mkStore();
  const source = new InMemoryProfileSource(profiles);
  const service = createDiscoveryService({
    store, profiles: source, credentials: { resolve: async () => null }, events, clock, rng: () => 0.5, table,
    roles: () => ({}), settings: () => ({ enabled: true, intervalHours: 24 }), logger: quiet, maxParallel,
    scanners: { "openai-models": scanner },
  });
  return { store, clock, source, service, events };
}
const prof = (id: string): ProfileInfo => ({ id, discovery: "openai-models", baseUrl: `https://${id}.example/v1` });

describe("b04: service robustness", () => {
  it("an event sink that throws while reporting a failure does not make scanProvider reject", async () => {
    const events = new RecordingEvents();
    events.scanFailed = () => { throw new Error("sink down"); };
    const s = mkService([prof("p1")], async () => { throw new ScanError("failed:network", "connection_refused"); }, events);
    const res = await s.service.scanProvider("p1", { trigger: "cron" });
    assert.equal(res.result, "failed:network");
    assert.equal(res.error?.retryable, true);
    assert.equal(s.store.read().providers.p1?.consecutiveFailures, 1, "the failure is still recorded");
  });

  it("scanAll keeps the other results when a provider disappears from the configuration mid-run", async () => {
    let s!: ReturnType<typeof mkService>;
    const scanner: Scanner = async (p) => {
      if (p.id === "p1") s.source.set([prof("p1")]); // p2 is removed while p1 is scanning
      return { entries: [{ id: "m1" }], duplicates: 0, pages: 1 };
    };
    s = mkService([prof("p1"), prof("p2")], scanner, new RecordingEvents(), 1);
    const results = await s.service.scanAll({ trigger: "manual" });
    assert.deepEqual(results.map((r) => [r.provider, r.result]), [["p1", "ok"]]);
  });
});
