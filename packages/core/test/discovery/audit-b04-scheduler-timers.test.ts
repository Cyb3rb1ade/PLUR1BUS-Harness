// Audit b04 (model discovery): scheduler-timers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createCatalogStore } from "../../src/discovery/catalog-store.ts";
import { createDiscoveryService } from "../../src/discovery/service.ts";
import { createScanScheduler } from "../../src/discovery/scheduler.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { FakeClock, InMemoryProfileSource, RecordingEvents } from "../../src/discovery/testing.ts";
import type { ProfileInfo } from "../../src/discovery/ports.ts";

const table = loadMetadataTable();
const quiet = { debug() {}, info() {}, warn() {} };

function mkStore(clock = new FakeClock(1_700_000_000_000)) {
  const dir = tempDir("p1b-b04-");
  const store = createCatalogStore({ path: join(dir, "models.json"), tableRevision: table.revision, clock, securePath: () => {}, logger: quiet });
  store.load();
  return { dir, store, clock };
}
const prof = (id: string): ProfileInfo => ({ id, discovery: "openai-models", baseUrl: `https://${id}.example/v1` });

describe("b04: scheduler timers", () => {
  it("never hands the clock a delay Node would clamp to 1 ms", async () => {
    const { store, clock } = mkStore();
    const delays: number[] = [];
    let scans = 0;
    const orig = clock.setTimer.bind(clock);
    clock.setTimer = (fn, ms) => { delays.push(ms); return orig(fn, ms); };
    const source = new InMemoryProfileSource([prof("p1")]);
    const service = createDiscoveryService({
      store, profiles: source, credentials: { resolve: async () => null }, events: new RecordingEvents(), clock, rng: () => 0.5, table,
      roles: () => ({}), settings: () => ({ enabled: true, intervalHours: 24 }), logger: quiet,
    });
    const now = clock.now();
    await store.mutate((c) => ({ next: { ...c, providers: { p1: {
      lastScanAt: new Date(now - 3600_000).toISOString(), lastResult: "failed:network", consecutiveFailures: 2,
      nextScanAt: new Date(now + 90 * 24 * 3600_000).toISOString(),
    } } }, result: 0 }));
    const sch = createScanScheduler({ service, store, systemRun: async () => { scans += 1; }, clock, rng: () => 0.5, settings: () => ({ enabled: true, intervalHours: 24 }), logger: { debug() {} } });
    sch.start();
    sch.replan();
    assert.ok(delays.length > 0);
    for (const d of delays) assert.ok(d <= 2 ** 31 - 1, `timer delay ${d} ms overflows setTimeout`);
    // The clamped timer fires early, finds the stored nextScanAt still ahead and re-arms without scanning.
    await clock.advance(2 ** 31);
    assert.equal(scans, 0);
    assert.equal(sch.armed().length, 1);
    sch.stop();
  });
});
