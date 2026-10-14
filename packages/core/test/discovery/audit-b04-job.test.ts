// Audit b04 (model discovery): branches of the models.scan job and the service that had no test.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createCatalogStore } from "../../src/discovery/catalog-store.ts";
import { createDiscoveryService } from "../../src/discovery/service.ts";
import { createModelsScanJob } from "../../src/discovery/job.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { ScanError } from "../../src/discovery/http.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { FakeClock, InMemoryProfileSource, RecordingEvents } from "../../src/discovery/testing.ts";
import type { Scanner } from "../../src/discovery/scanners/index.ts";
import type { ProfileInfo } from "../../src/discovery/ports.ts";

const table = loadMetadataTable();
const quiet = { debug() {}, info() {}, warn() {} };
const prof = (id: string, discovery: ProfileInfo["discovery"] = "openai-models"): ProfileInfo => ({ id, discovery, baseUrl: `https://${id}.example/v1` });

function mk(profiles: ProfileInfo[], scanner: Scanner, opts: { enabled?: boolean } = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const store = createCatalogStore({ path: join(tempDir("p1b-b04-job-"), "models.json"), tableRevision: table.revision, clock, securePath: () => {}, logger: quiet });
  store.load();
  const events = new RecordingEvents();
  const changes: unknown[] = [];
  const settings = { enabled: opts.enabled ?? true, intervalHours: 24 };
  const service = createDiscoveryService({
    store, profiles: new InMemoryProfileSource(profiles), credentials: { resolve: async () => null }, events, clock, rng: () => 0.5, table,
    roles: () => ({}), settings: () => settings, logger: quiet, scanners: { "openai-models": scanner },
  });
  service.onChanged((e) => changes.push(e));
  const job = createModelsScanJob(service, () => settings);
  return { clock, store, events, service, job, changes, settings };
}
const ctx = (signal = new AbortController().signal) => ({ runId: "r1", trigger: "manual" as const, signal });
const list = (...ids: string[]): Scanner => async () => ({ entries: ids.map((id) => ({ id })), duplicates: 0, pages: 1 });

describe("b04: models.scan job", () => {
  it("validateArgs accepts nothing or a known provider and refuses everything else", () => {
    const { job } = mk([prof("p1")], list("m"));
    assert.deepEqual(job.validateArgs(undefined), {});
    assert.deepEqual(job.validateArgs(null), {});
    assert.deepEqual(job.validateArgs({ provider: "p1" }), { provider: "p1" });
    for (const bad of ["x", [], { provider: 3 }, { provider: "nope" }, { other: 1 }]) {
      assert.throws(() => job.validateArgs(bad), (e: unknown) => e instanceof RpcError, JSON.stringify(bad));
    }
  });
  it("reports completed, failed, skipped and abandoned", async () => {
    const ok = mk([prof("p1")], list("m"));
    assert.equal((await ok.job.run({}, ctx())).outcome, "completed");

    const failing = mk([prof("p1")], async () => { throw new ScanError("failed:network", "connection_refused"); });
    const f = await failing.job.run({}, ctx());
    assert.equal(f.outcome, "failed");

    const off = mk([prof("p1")], list("m"), { enabled: false });
    const sk = await off.job.run({}, ctx());
    assert.equal(sk.outcome, "skipped");
    assert.equal(sk.reason, "disabled");

    const none = mk([prof("p1", "manual")], list("m"));
    assert.equal((await none.job.run({ provider: "p1" }, ctx())).reason, "no-scanner");

    const ac = new AbortController(); ac.abort();
    const ab = await ok.job.run({}, ctx(ac.signal));
    assert.equal(ab.outcome, "abandoned");
  });
});

describe("b04: service branches", () => {
  it("a model that leaves the list is reported once as unavailable and fires one change", async () => {
    let ids = ["a", "b"];
    const s = mk([prof("p1")], async () => ({ entries: ids.map((id) => ({ id })), duplicates: 0, pages: 1 }));
    await s.service.scanProvider("p1", { trigger: "manual" });
    ids = ["a"];
    const res = await s.service.scanProvider("p1", { trigger: "manual" });
    assert.deepEqual(res.unavailable, ["b"]);
    assert.equal(s.events.log.filter((e) => e.name === "unavailable").length, 1);
    assert.equal(s.changes.length, 2);
    assert.equal(s.service.list({ status: "unavailable" }).models.length, 1);
  });
  it("list(newOnly) shows unacknowledged models until acknowledge()", async () => {
    const s = mk([prof("p1")], list("a"));
    await s.service.scanProvider("p1", { trigger: "manual" });
    assert.equal(s.service.list({ newOnly: true }).newCount, 1);
    await s.clock.advance(1000);
    await s.service.acknowledge();
    assert.equal(s.service.list({ newOnly: true }).models.length, 0);
    assert.equal(s.service.list({ kind: "chat" }).models.length + s.service.list({ kind: "unknown" }).models.length, 1);
  });
  it("nextRunAt is the earliest scannable nextScanAt and null without any", async () => {
    const s = mk([prof("p1"), prof("p2")], list("a"));
    assert.equal(s.service.nextRunAt(), null);
    await s.service.scanProvider("p1", { trigger: "manual" });
    assert.equal(s.service.nextRunAt(), Date.parse(s.store.read().providers.p1!.nextScanAt!));
  });
  it("a scan that is cancelled before it starts leaves the catalog and failure counters alone", async () => {
    const s = mk([prof("p1")], list("a"));
    const ac = new AbortController(); ac.abort();
    const res = await s.service.scanProvider("p1", { trigger: "cron", signal: ac.signal });
    assert.equal(res.error?.reason, "aborted");
    assert.equal(s.store.read().revision, 0);
  });
});
