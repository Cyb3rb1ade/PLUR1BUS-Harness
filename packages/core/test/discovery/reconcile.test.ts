import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../../src/discovery/reconcile.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { emptyCatalog } from "../../src/discovery/types.ts";
import type { CatalogFile, CatalogModel, RawEntry } from "../../src/discovery/types.ts";

const table = loadMetadataTable();
const now1 = "2026-10-03T10:00:00.000Z";
const now2 = "2026-10-03T11:00:00.000Z";
const now3 = "2026-10-03T12:00:00.000Z";

describe("reconcile", () => {
  it("new: available, counted, role untouched", () => {
    const catalog = emptyCatalog(table.revision);
    const roles = Object.freeze({ chat: "example-compat/example-chat-large" });
    const raw: RawEntry[] = [{ id: "example-chat-large" }];

    const res = reconcile({
      catalog,
      provider: "example-compat",
      raw,
      now: now1,
      table,
      vendor: "example-vendor",
      roles,
    });

    assert.deepEqual(res.new, ["example-chat-large"]);
    assert.deepEqual(res.reappeared, []);
    assert.deepEqual(res.unavailable, []);
    assert.equal(res.unchanged, 0);
    assert.deepEqual(res.shadowed, []);

    const m = res.catalog.models.find((x) => x.id === "example-chat-large")!;
    assert.ok(m);
    assert.equal(m.status, "available");
    assert.equal(m.firstSeen, now1);
    assert.equal(m.lastSeen, now1);
    assert.equal(JSON.stringify(roles), JSON.stringify({ chat: "example-compat/example-chat-large" }));
  });

  it("gone: becomes unavailable, lastSeen unchanged, not deleted", () => {
    const catalog = emptyCatalog(table.revision);
    const roles = { chat: "other" };
    const step1 = reconcile({
      catalog,
      provider: "p1",
      raw: [{ id: "m1" }, { id: "m2" }],
      now: now1,
      table,
      roles,
    });

    // In step2, m2 is gone from raw list
    const step2 = reconcile({
      catalog: step1.catalog,
      provider: "p1",
      raw: [{ id: "m1" }],
      now: now2,
      table,
      roles,
    });

    assert.equal(step2.catalog.models.length, 2);
    assert.deepEqual(step2.unavailable, ["m2"]);
    const m2 = step2.catalog.models.find((x) => x.id === "m2")!;
    assert.equal(m2.status, "unavailable");
    assert.equal(m2.firstSeen, now1);
    assert.equal(m2.lastSeen, now1, "lastSeen is unchanged when unavailable");
  });

  it("back: available again, counted as reappeared not new", () => {
    const catalog = emptyCatalog(table.revision);
    const roles = {};
    const step1 = reconcile({ catalog, provider: "p1", raw: [{ id: "m1" }], now: now1, table, roles });
    const step2 = reconcile({ catalog: step1.catalog, provider: "p1", raw: [{ id: "m2" }], now: now2, table, roles });
    // m1 was unavailable. Now m1 is back!
    const step3 = reconcile({ catalog: step2.catalog, provider: "p1", raw: [{ id: "m1" }, { id: "m2" }], now: now3, table, roles });

    assert.deepEqual(step3.new, []);
    assert.deepEqual(step3.reappeared, ["m1"]);
    assert.equal(step3.unchanged, 1); // m2 is unchanged
    const m1 = step3.catalog.models.find((x) => x.id === "m1")!;
    assert.equal(m1.status, "available");
    assert.equal(m1.lastSeen, now3);
    assert.equal(m1.firstSeen, now1);
  });

  it("an override is kept across new, gone and back", () => {
    const catalog = emptyCatalog(table.revision);
    const roles = {};
    const step1 = reconcile({ catalog, provider: "p1", raw: [{ id: "m1" }], now: now1, table, roles });
    // attach override to m1
    step1.catalog.models[0]!.overrides = { displayName: "My Large", contextWindow: 32000 };
    step1.catalog.models[0]!.displayName = "My Large";
    step1.catalog.models[0]!.contextWindow = 32000;

    // m1 goes unavailable
    const step2 = reconcile({ catalog: step1.catalog, provider: "p1", raw: [{ id: "m2" }], now: now2, table, roles });
    const m1Gone = step2.catalog.models.find((x) => x.id === "m1")!;
    assert.equal(m1Gone.status, "unavailable");
    assert.equal(m1Gone.displayName, "My Large");
    assert.equal(m1Gone.contextWindow, 32000);

    // m1 comes back
    const step3 = reconcile({ catalog: step2.catalog, provider: "p1", raw: [{ id: "m1" }], now: now3, table, roles });
    const m1Back = step3.catalog.models.find((x) => x.id === "m1")!;
    assert.equal(m1Back.status, "available");
    assert.equal(m1Back.displayName, "My Large");
    assert.equal(m1Back.contextWindow, 32000);
    assert.deepEqual(m1Back.overrides, { displayName: "My Large", contextWindow: 32000 });
  });

  it("refresh: API value changes, override still wins", () => {
    const catalog = emptyCatalog(table.revision);
    const roles = {};
    const step1 = reconcile({ catalog, provider: "p1", raw: [{ id: "m1", displayName: "V1" }], now: now1, table, roles });
    step1.catalog.models[0]!.overrides = { displayName: "Custom" };
    step1.catalog.models[0]!.displayName = "Custom";

    const step2 = reconcile({ catalog: step1.catalog, provider: "p1", raw: [{ id: "m1", displayName: "V2" }], now: now2, table, roles });
    const m1 = step2.catalog.models.find((x) => x.id === "m1")!;
    assert.equal(m1.displayName, "Custom");
    assert.equal(m1.api?.displayName, "V2");
  });

  it("a role pointing at an unavailable model warns and is unchanged", () => {
    const catalog = emptyCatalog(table.revision);
    const roles = Object.freeze({ chat: "example-compat/example-chat-large" });
    // First scan has example-chat-large
    const step1 = reconcile({
      catalog,
      provider: "example-compat",
      raw: [{ id: "example-chat-large" }],
      now: now1,
      table,
      roles,
    });

    // Second scan: example-chat-large is gone
    const step2 = reconcile({
      catalog: step1.catalog,
      provider: "example-compat",
      raw: [{ id: "other-model" }],
      now: now2,
      table,
      roles,
    });

    assert.deepEqual(step2.warnings, [
      { code: "role_unavailable", role: "chat", provider: "example-compat", id: "example-chat-large" },
    ]);
    assert.equal(JSON.stringify(roles), JSON.stringify({ chat: "example-compat/example-chat-large" }));
  });

  it("a manual entry is untouched and a colliding raw id is reported as shadowed", () => {
    const manualModel: CatalogModel = {
      provider: "p1",
      id: "example-manual",
      displayName: "Manual Model",
      kind: "chat",
      capabilities: [],
      aliases: [],
      status: "manual",
      firstSeen: now1,
      lastSeen: now1,
      source: "manual",
      overrides: {},
    };
    const catalog: CatalogFile = {
      ...emptyCatalog(table.revision),
      models: [structuredClone(manualModel)],
    };

    const res = reconcile({
      catalog,
      provider: "p1",
      raw: [{ id: "example-manual", displayName: "Scanned Collision" }],
      now: now2,
      table,
      roles: {},
    });

    assert.deepEqual(res.shadowed, ["example-manual"]);
    assert.deepEqual(res.warnings, [
      { code: "shadowed_by_manual", provider: "p1", id: "example-manual" },
    ]);
    const m = res.catalog.models.find((x) => x.id === "example-manual")!;
    assert.deepEqual(m, manualModel, "manual entry is byte-identical");
  });

  it("manual entries never become unavailable; other providers are untouched", () => {
    const manualModel: CatalogModel = {
      provider: "p1",
      id: "manual-1",
      displayName: "Manual 1",
      kind: "chat",
      capabilities: [],
      aliases: [],
      status: "manual",
      firstSeen: now1,
      lastSeen: now1,
      source: "manual",
      overrides: {},
    };
    const otherProviderModel: CatalogModel = {
      provider: "p2",
      id: "p2-model",
      displayName: "P2 Model",
      kind: "chat",
      capabilities: [],
      aliases: [],
      status: "available",
      firstSeen: now1,
      lastSeen: now1,
      source: "scan",
      overrides: {},
    };
    const catalog: CatalogFile = {
      ...emptyCatalog(table.revision),
      models: [manualModel, otherProviderModel],
    };

    // Reconcile p1 with empty-of-manual-1 raw list
    const res = reconcile({
      catalog,
      provider: "p1",
      raw: [{ id: "scanned-p1" }],
      now: now2,
      table,
      roles: {},
    });

    const m = res.catalog.models.find((x) => x.id === "manual-1")!;
    assert.equal(m.status, "manual");
    const p2m = res.catalog.models.find((x) => x.id === "p2-model")!;
    assert.equal(p2m.status, "available");
  });

  it("source flips between table and scan", () => {
    const catalog = emptyCatalog(table.revision);
    // 1. Scan without capabilities/kind in raw -> table enriches it -> source is "table"
    const step1 = reconcile({
      catalog,
      provider: "example-compat",
      raw: [{ id: "example-chat-large" }],
      now: now1,
      table,
      vendor: "example-vendor",
      roles: {},
    });
    assert.equal(step1.catalog.models[0]!.source, "table");

    // 2. Next scan provides all capabilities and kind -> source becomes "scan"
    const step2 = reconcile({
      catalog: step1.catalog,
      provider: "example-compat",
      raw: [{ id: "example-chat-large", kind: "chat", contextWindow: 64000, capabilities: ["tools"] }],
      now: now2,
      table,
      vendor: "example-vendor",
      roles: {},
    });
    assert.equal(step2.catalog.models[0]!.source, "scan");
  });

  it("an empty raw list throws RangeError", () => {
    const catalog = emptyCatalog(table.revision);
    assert.throws(
      () => reconcile({ catalog, provider: "p1", raw: [], now: now1, table, roles: {} }),
      RangeError,
    );
  });

  it("enforces resolved alias uniqueness per provider on reconcile with a colliding table (F4)", () => {
    const collidingTable = loadMetadataTable({
      schema: "plur1bus.model-metadata/1",
      revision: "test-rev-colliding",
      vendors: {
        "test-vendor": [
          {
            pattern: "^col-.*$",
            kind: "chat",
            capabilities: [],
            aliases: ["shared-alias"],
          },
        ],
      },
    });

    const catalog = emptyCatalog(collidingTable.revision);
    const logs: string[] = [];
    const logger = { debug: (m: string) => { logs.push(m); } };

    const res = reconcile({
      catalog,
      provider: "p1",
      raw: [
        { id: "col-20260101", created: 1000 },
        { id: "col-base", created: 2000 },
      ],
      now: now1,
      table: collidingTable,
      vendor: "test-vendor",
      roles: {},
      logger,
    });

    const mBase = res.catalog.models.find((m) => m.id === "col-base")!;
    const mDated = res.catalog.models.find((m) => m.id === "col-20260101")!;
    // col-base won because created: 2000 > 1000 (and also base match)
    assert.deepEqual(mBase.aliases, ["shared-alias"]);
    assert.deepEqual(mDated.aliases, []);
    assert.ok(logs.some((l) => l.includes("resolved alias collision")));
  });

  it("dedup is per-provider: same alias on different providers is allowed (F4)", () => {
    const collidingTable = loadMetadataTable({
      schema: "plur1bus.model-metadata/1",
      revision: "test-rev-colliding",
      vendors: {
        "test-vendor": [
          {
            pattern: "^col-.*$",
            kind: "chat",
            capabilities: [],
            aliases: ["shared-alias"],
          },
        ],
      },
    });

    const p1Model: CatalogModel = {
      provider: "p1",
      id: "col-p1",
      displayName: "Col P1",
      kind: "chat",
      capabilities: [],
      aliases: ["shared-alias"],
      status: "available",
      firstSeen: now1,
      lastSeen: now1,
      source: "table",
      overrides: {},
    };

    const catalog: CatalogFile = {
      ...emptyCatalog(collidingTable.revision),
      models: [p1Model],
    };

    // Reconcile p2: it also gets "shared-alias" from table
    const res = reconcile({
      catalog,
      provider: "p2",
      raw: [{ id: "col-p2" }],
      now: now2,
      table: collidingTable,
      vendor: "test-vendor",
      roles: {},
    });

    const m1 = res.catalog.models.find((m) => m.provider === "p1")!;
    const m2 = res.catalog.models.find((m) => m.provider === "p2")!;
    assert.deepEqual(m1.aliases, ["shared-alias"]);
    assert.deepEqual(m2.aliases, ["shared-alias"]);
    // Original p1Model was not mutated in place
    assert.notEqual(res.catalog.models.find((m) => m.provider === "p1"), p1Model);
  });
});
