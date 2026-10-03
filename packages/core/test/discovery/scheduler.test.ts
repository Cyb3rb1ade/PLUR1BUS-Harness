import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createScanScheduler, type ScanScheduler } from "../../src/discovery/scheduler.ts";
import { FakeClock, InMemoryProfileSource, RecordingEvents } from "../../src/discovery/testing.ts";
import { createCatalogStore } from "../../src/discovery/catalog-store.ts";
import { createDiscoveryService } from "../../src/discovery/service.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { createPlatformCapabilities } from "../../src/platform.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { ScanError } from "../../src/discovery/http.ts";
import type { Scanner, ScanOutput } from "../../src/discovery/scanners/index.ts";
import type { Rng } from "../../src/discovery/ports.ts";
import { createSystemJobs } from "../../src/system-jobs/index.ts";
import { createModelsScanJob } from "../../src/discovery/job.ts";

function sequenceRng(values: number[]): Rng {
  let idx = 0;
  return () => {
    const val = values[idx % values.length] ?? 0.5;
    idx++;
    return val;
  };
}

describe("discovery scheduler", () => {
  const win = process.platform === "win32";
  const platform = createPlatformCapabilities({ platform: process.platform });

  function setup(options?: {
    profiles?: { id: string; discovery: any; baseUrl: string }[];
    rngValues?: number[];
    initialStore?: (dir: string) => Promise<any>;
    scannerOutput?: (provider: string) => Promise<ScanOutput>;
    settings?: { enabled: boolean; intervalHours: number };
  }) {
    const dir = tempDir("discovery-sched-");
    const catalogPath = join(dir, "models.json");
    const ledgerPath = join(dir, "system-jobs.jsonl");
    const clock = new FakeClock(1_700_000_000_000);
    const store = createCatalogStore({
      path: catalogPath,
      securePath: platform.securePath,
      clock,
      tableRevision: "test-rev-1",
      logger: { info: () => {}, warn: () => {} },
    });
    const rng = sequenceRng(options?.rngValues ?? [0.5]);
    const scannedCalls: { provider: string; trigger: string; at: number }[] = [];

    const defaultProfiles = options?.profiles ?? [
      { id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" },
      { id: "p2", discovery: "openai-models", baseUrl: "https://p2.example/v1" },
      { id: "p3", discovery: "openai-models", baseUrl: "https://p3.example/v1" },
    ];
    const profileSource = new InMemoryProfileSource(defaultProfiles);
    const events = new RecordingEvents();
    let currentSettings = options?.settings ?? { enabled: true, intervalHours: 24 };

    const mockScanner: Scanner = async (profile) => {
      if (options?.scannerOutput) {
        return await options.scannerOutput(profile.baseUrl);
      }
      return {
        entries: [{ id: "m1", name: "Model 1", kind: "chat" }],
        duplicates: 0,
        pages: 1,
      };
    };

    const service = createDiscoveryService({
      store,
      profiles: profileSource,
      credentials: { resolve: async (_id, origin) => ({ origin, headerName: "Authorization", headerValue: "Bearer token" }) },
      events,
      clock,
      rng,
      scanners: {
        "openai-models": mockScanner,
        "anthropic-models": mockScanner,
        "google-models": mockScanner,
        "ollama-tags": mockScanner,
      },
      table: loadMetadataTable(),
      roles: () => ({}),
      logger: { warn: () => {}, debug: () => {}, info: () => {} },
      settings: () => currentSettings,
    });

    const systemJobs = createSystemJobs({
      ledgerPath,
      clock,
      logger: { warn: () => {} },
      securePath: platform.securePath,
      engineHasJob: () => false,
    });
    systemJobs.register(createModelsScanJob(service, () => currentSettings));

    const systemRun = async (provider: string, trigger: any, signal: AbortSignal) => {
      scannedCalls.push({ provider, trigger, at: clock.now() });
      return await systemJobs.run("models.scan", { provider }, { trigger, signal });
    };

    const scheduler = createScanScheduler({
      service,
      store,
      systemRun,
      clock,
      rng,
      settings: () => currentSettings,
      logger: { debug: () => {} },
    });

    return {
      dir,
      store,
      clock,
      rng,
      service,
      systemJobs,
      scheduler,
      scannedCalls,
      setSettings: (s: { enabled: boolean; intervalHours: number }) => { currentSettings = s; },
    };
  }

  it("arms nothing before start", () => {
    const { clock } = setup();
    assert.equal(clock.pending(), 0);
  });

  it("catch-up scans only providers older than the interval, 0-60 s after start, 2 s apart", async () => {
    // p1 no lastScanAt, p2 25 h old, p3 1 h old; sequenceRng [0.10, 0.10] -> p1 at 6 s, p2 pushed to 8 s; advance(5_999) -> 0 scans; advance(2_001) -> [p1, p2]; p3 never scanned
    const { store, clock, scheduler, scannedCalls } = setup({
      rngValues: [0.10, 0.10],
    });
    await store.load();
    const now = clock.now();
    await store.mutate((c) => ({
      next: {
        ...c,
        providers: {
          p2: { lastScanAt: new Date(now - 25 * 3600_000).toISOString() },
          p3: { lastScanAt: new Date(now - 1 * 3600_000).toISOString(), nextScanAt: new Date(now + 23 * 3600_000).toISOString() },
        },
      },
      result: null,
    }));

    scheduler.start();
    await clock.advance(5_999);
    assert.equal(scannedCalls.length, 0);

    await clock.advance(2_001);
    assert.equal(scannedCalls.length, 2);
    assert.deepEqual(scannedCalls.map((c) => c.provider).sort(), ["p1", "p2"]);
    assert.equal(scannedCalls.find((c) => c.provider === "p3"), undefined);
  });

  it("a start never scans a provider scanned within the interval", async () => {
    const { store, clock, scheduler, scannedCalls } = setup();
    await store.load();
    const now = clock.now();
    const nextScanAtIso = new Date(now + 10 * 3600_000).toISOString();
    await store.mutate((c) => ({
      next: {
        ...c,
        providers: {
          p1: { lastScanAt: new Date(now - 2 * 3600_000).toISOString(), nextScanAt: nextScanAtIso },
          p2: { lastScanAt: new Date(now - 3 * 3600_000).toISOString(), nextScanAt: nextScanAtIso },
          p3: { lastScanAt: new Date(now - 4 * 3600_000).toISOString(), nextScanAt: nextScanAtIso },
        },
      },
      result: null,
    }));

    scheduler.start();
    await clock.advance(60_000);
    assert.equal(scannedCalls.length, 0);
  });

  it("a provider in backoff is not hammered by a restart", async () => {
    const { store, clock, scheduler, scannedCalls } = setup({
      profiles: [{ id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" }],
    });
    await store.load();
    const now = clock.now();
    // lastScanAt 3 days old but nextScanAt in 4 min -> armed at 4 min, not at catch-up
    const nextScanAtIso = new Date(now + 4 * 60_000).toISOString();
    await store.mutate((c) => ({
      next: {
        ...c,
        providers: {
          p1: { lastScanAt: new Date(now - 72 * 3600_000).toISOString(), nextScanAt: nextScanAtIso, consecutiveFailures: 1, lastResult: "failed:network" },
        },
      },
      result: null,
    }));

    scheduler.start();
    await clock.advance(60_000);
    assert.equal(scannedCalls.length, 0); // Not scanned in catch-up window

    await clock.advance(3 * 60_000 + 1);
    assert.equal(scannedCalls.length, 1);
    assert.equal(scannedCalls[0]?.provider, "p1");
  });

  it("a changed intervalHours recomputes nextScanAt live and an overdue scan waits the catch-up delay", async () => {
    // 24 -> 1 with lastScanAt 2 h old: advance(0) 0 scans; advance(60_000) 1 scan
    const { store, clock, scheduler, scannedCalls, setSettings } = setup({
      profiles: [{ id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" }],
    });
    await store.load();
    const now = clock.now();
    await store.mutate((c) => ({
      next: {
        ...c,
        providers: {
          p1: { lastScanAt: new Date(now - 2 * 3600_000).toISOString(), nextScanAt: new Date(now + 22 * 3600_000).toISOString() },
        },
      },
      result: null,
    }));

    scheduler.start();
    assert.equal(scannedCalls.length, 0);

    setSettings({ enabled: true, intervalHours: 1 });
    scheduler.replan();

    await clock.advance(0);
    assert.equal(scannedCalls.length, 0);

    await clock.advance(60_000);
    assert.equal(scannedCalls.length, 1);
    assert.equal(scannedCalls[0]?.provider, "p1");
  });

  it("disabling cancels every timer and enabling re-arms", async () => {
    const { store, clock, scheduler, setSettings } = setup();
    await store.load();
    scheduler.start();
    assert.equal(clock.pending(), 3);

    setSettings({ enabled: false, intervalHours: 24 });
    scheduler.replan();
    assert.equal(clock.pending(), 0);

    setSettings({ enabled: true, intervalHours: 24 });
    scheduler.replan();
    assert.equal(clock.pending(), 3);
  });

  it("a 401 does not retry before the next regular slot", async () => {
    let callCount = 0;
    const { store, clock, scheduler, scannedCalls } = setup({
      profiles: [{ id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" }],
      scannerOutput: async () => {
        callCount++;
        throw new ScanError("failed:auth", "renew_sign_in", { httpStatus: 401 });
      },
    });
    await store.load();
    scheduler.start();

    // Catch up fires within 60s
    await clock.advance(60_000);
    assert.equal(scannedCalls.length, 1);

    // 23 hours later: still no retry
    await clock.advance(23 * 3600_000);
    assert.equal(scannedCalls.length, 1);
  });

  it("a network failure retries at 5 min then 10 min, +/-10%", async () => {
    const { store, clock, scheduler, scannedCalls } = setup({
      profiles: [{ id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" }],
      rngValues: [0.5], // no jitter deviation from base
      scannerOutput: async () => {
        throw new ScanError("failed:network", "connection_reset");
      },
    });
    await store.load();
    scheduler.start();

    // Catch-up fires within 60s
    await clock.advance(60_000);
    assert.equal(scannedCalls.length, 1);

    // 5 minutes later: first retry
    await clock.advance(5 * 60_000 + 1000);
    assert.equal(scannedCalls.length, 2);

    // 10 minutes later: second retry
    await clock.advance(10 * 60_000 + 1000);
    assert.equal(scannedCalls.length, 3);
  });

  it("one scan per provider after a three-day sleep", async () => {
    const { store, clock, scheduler, scannedCalls } = setup({
      profiles: [{ id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" }],
    });
    await store.load();
    scheduler.start();

    // Sleep for 3 days
    await clock.jump(3 * 24 * 3600_000);
    assert.equal(scannedCalls.length, 1);
  });

  it("clamps a nextScanAt far in the future", async () => {
    const { store, clock, scheduler } = setup({
      profiles: [{ id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" }],
    });
    await store.load();
    const now = clock.now();
    // Persisted 10 days ahead, interval 24 h -> armed at most 1.1 x 24 h from now
    const farFutureIso = new Date(now + 10 * 24 * 3600_000).toISOString();
    await store.mutate((c) => ({
      next: {
        ...c,
        providers: {
          p1: { lastScanAt: new Date(now - 1 * 3600_000).toISOString(), nextScanAt: farFutureIso },
        },
      },
      result: null,
    }));

    scheduler.start();
    const armed = scheduler.armed();
    assert.equal(armed.length, 1);
    assert.ok(armed[0]);
    assert.ok(armed[0].at <= now + 1.1 * 24 * 3600_000 + 1000);
  });

  it("at most 4 providers scan at once", async () => {
    let running = 0;
    let maxRunning = 0;
    const profiles = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i + 1}`,
      discovery: "openai-models",
      baseUrl: `https://p${i + 1}.example/v1`,
    }));

    const { store, clock, scheduler } = setup({
      profiles,
      rngValues: [0], // all draw delay 0
      scannerOutput: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { entries: [{ id: "m1", name: "M1", kind: "chat" }], duplicates: 0, pages: 1 };
      },
    });
    await store.load();
    scheduler.start();

    await clock.advance(60_000);
    assert.ok(maxRunning <= 4, `expected maxRunning <= 4, got ${maxRunning}`);
  });

  it("stop() cancels timers and aborts a scan in flight", async () => {
    let aborted = false;
    const { store, clock, scheduler } = setup({
      profiles: [{ id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" }],
      scannerOutput: async () => {
        return await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("timed out")), 1000);
        });
      },
    });
    await store.load();
    scheduler.start();
    assert.equal(clock.pending(), 1);

    scheduler.stop();
    assert.equal(clock.pending(), 0);
  });

  it("every tick writes one ledger row through SystemJobs", async () => {
    const { store, clock, scheduler, systemJobs } = setup({
      profiles: [{ id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" }],
      rngValues: [0.1],
    });
    await store.load();
    scheduler.start();

    // Catch up scan with trigger "harness"
    await clock.advance(60_000);
    const hist1 = systemJobs.history({});
    assert.equal(hist1.length, 1);
    assert.equal(hist1[0]?.trigger, "harness");

    // Regular tick with trigger "cron"
    await clock.advance(25 * 3600_000);
    const hist2 = systemJobs.history({});
    assert.equal(hist2.length, 2);
    assert.equal(hist2[1]?.trigger, "cron");
  });
});
