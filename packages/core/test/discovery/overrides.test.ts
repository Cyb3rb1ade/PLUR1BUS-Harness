import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyOverride, removeManualEntry, CatalogError } from "../../src/discovery/overrides.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { emptyCatalog } from "../../src/discovery/types.ts";
import type { CatalogFile, CatalogModel } from "../../src/discovery/types.ts";

const table = loadMetadataTable();
const now = "2026-10-03T10:00:00.000Z";

function baseModel(id: string, provider = "p1", source: CatalogModel["source"] = "scan"): CatalogModel {
  return {
    provider,
    id,
    displayName: id,
    kind: "chat",
    capabilities: [],
    aliases: [],
    status: source === "manual" ? "manual" : "available",
    firstSeen: now,
    lastSeen: now,
    source,
    overrides: {},
  };
}

describe("overrides", () => {
  it("validates fields and throws CatalogError with field name", () => {
    const catalog: CatalogFile = {
      ...emptyCatalog(table.revision),
      models: [baseModel("m1"), baseModel("m2")],
    };

    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", set: { kind: "chatty" as unknown as "chat" } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "kind",
    );

    for (const badCw of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(
        () => applyOverride(catalog, { provider: "p1", id: "m1", set: { contextWindow: badCw } }, now, table, undefined),
        (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "contextWindow",
      );
    }

    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", set: { capabilities: ["telepathy" as unknown as "tools"] } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "capabilities",
    );

    const aliases17 = Array.from({ length: 17 }, (_, i) => `alias-${i}`);
    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", set: { aliases: aliases17 } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "aliases",
    );

    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", set: { aliases: ["dup", "dup"] } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "aliases",
    );

    // Alias equal to another id of the provider -> conflict
    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", set: { aliases: ["m2"] } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "conflict" && e.field === "aliases",
    );

    // Alias equal to another model's alias -> conflict (F4)
    const catalogWithAlias: CatalogFile = {
      ...emptyCatalog(table.revision),
      models: [baseModel("m1"), { ...baseModel("m2"), aliases: ["m2-alias"] }],
    };
    assert.throws(
      () => applyOverride(catalogWithAlias, { provider: "p1", id: "m1", set: { aliases: ["m2-alias"] } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "conflict" && e.field === "aliases",
    );

    // String caps: > 512 bytes or control chars (Minor M5)
    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", set: { displayName: "a".repeat(513) } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "displayName",
    );
    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", set: { displayName: "bad\nname" } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "displayName",
    );
    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", set: { aliases: ["bad\x00alias"] } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "aliases",
    );

    // Clear validation (Minor M5)
    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "m1", clear: ["invalidKey" as any] }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "clear",
    );
  });

  it("create makes a manual entry and duplicate create is conflict", () => {
    const catalog = emptyCatalog(table.revision);
    const res = applyOverride(
      catalog,
      {
        provider: "p1",
        id: "custom-1",
        create: true,
        set: { displayName: "Custom Model", kind: "chat", contextWindow: 64000 },
      },
      now,
      table,
      undefined,
    );

    assert.equal(res.entry.status, "manual");
    assert.equal(res.entry.source, "manual");
    assert.equal(res.entry.displayName, "Custom Model");
    assert.equal(res.entry.kind, "chat");
    assert.equal(res.entry.contextWindow, 64000);

    // Creating again with same id is conflict
    assert.throws(
      () => applyOverride(res.catalog, { provider: "p1", id: "custom-1", create: true }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "conflict",
    );
  });

  it("set on a missing entry without create is not-found", () => {
    const catalog = emptyCatalog(table.revision);
    assert.throws(
      () => applyOverride(catalog, { provider: "p1", id: "non-existent", set: { displayName: "X" } }, now, table, undefined),
      (e: unknown) => e instanceof CatalogError && e.code === "not-found",
    );
  });

  it("clear: ['kind'] and clear: 'all' return to table/heuristic values", () => {
    const m = baseModel("example-chat-large", "example-compat");
    m.api = { displayName: "API Name" };
    m.overrides = { displayName: "Override Name", kind: "tts", contextWindow: 50000 };
    m.displayName = "Override Name";
    m.kind = "tts";
    m.contextWindow = 50000;

    const catalog: CatalogFile = {
      ...emptyCatalog(table.revision),
      models: [m],
    };

    // Clear kind: should revert to table (which has "chat" for example-chat-large in example-vendor)
    const res1 = applyOverride(
      catalog,
      { provider: "example-compat", id: "example-chat-large", clear: ["kind"] },
      now,
      table,
      "example-vendor",
    );
    assert.equal(res1.entry.kind, "chat");
    assert.equal(res1.entry.displayName, "Override Name");

    // Clear all: should revert all overrides
    const res2 = applyOverride(
      res1.catalog,
      { provider: "example-compat", id: "example-chat-large", clear: "all" },
      now,
      table,
      "example-vendor",
    );
    assert.equal(res2.entry.displayName, "API Name");
    assert.equal(res2.entry.contextWindow, 128000); // from table
    assert.deepEqual(res2.entry.overrides, {});
  });

  it("removeManualEntry removes a manual entry and refuses scan entry or missing", () => {
    const manual = baseModel("man-1", "p1", "manual");
    const scan = baseModel("scan-1", "p1", "scan");
    const catalog: CatalogFile = {
      ...emptyCatalog(table.revision),
      models: [manual, scan],
    };

    // Non-manual refuses with not-manual
    assert.throws(
      () => removeManualEntry(catalog, "p1", "scan-1"),
      (e: unknown) => e instanceof CatalogError && e.code === "not-manual",
    );

    // Missing refuses with not-found
    assert.throws(
      () => removeManualEntry(catalog, "p1", "missing"),
      (e: unknown) => e instanceof CatalogError && e.code === "not-found",
    );

    // Removes manual entry
    const next = removeManualEntry(catalog, "p1", "man-1");
    assert.equal(next.models.length, 1);
    assert.equal(next.models[0]!.id, "scan-1");
  });
});
