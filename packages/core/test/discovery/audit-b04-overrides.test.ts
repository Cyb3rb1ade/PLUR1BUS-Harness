// Audit b04 (model discovery): overrides.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createCatalogStore } from "../../src/discovery/catalog-store.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { applyOverride, CatalogError } from "../../src/discovery/overrides.ts";
import { FakeClock } from "../../src/discovery/testing.ts";
import { emptyCatalog } from "../../src/discovery/types.ts";
import type { CatalogFile, CatalogModel } from "../../src/discovery/types.ts";

const table = loadMetadataTable();
const NOW = "2026-10-14T10:00:00.000Z";
const quiet = { debug() {}, info() {}, warn() {} };

function mkStore(clock = new FakeClock(1_700_000_000_000)) {
  const dir = tempDir("p1b-b04-");
  const store = createCatalogStore({ path: join(dir, "models.json"), tableRevision: table.revision, clock, securePath: () => {}, logger: quiet });
  store.load();
  return { dir, store, clock };
}
const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  provider: "p1", id, displayName: id, kind: "chat", capabilities: [], aliases: [], status: "available",
  firstSeen: NOW, lastSeen: NOW, source: "scan", overrides: {}, ...extra,
});

describe("b04: overrides validation", () => {
  const cat = (): CatalogFile => emptyCatalog(table.revision);
  it("create refuses ids a catalog file cannot hold", () => {
    for (const id of ["", "bad\u0007id", "x".repeat(600)]) {
      assert.throws(() => applyOverride(cat(), { provider: "p1", id, create: true }, NOW, table, undefined), (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "id", JSON.stringify(id.slice(0, 8)));
    }
  });
  it("contextWindow beyond the safe integer range is invalid, not a raw write failure", async () => {
    const { store } = mkStore();
    await assert.rejects(
      store.mutate((c) => ({ next: applyOverride(c, { provider: "p1", id: "m", create: true, set: { contextWindow: 2 ** 60 } }, NOW, table, undefined).catalog, result: 0 })),
      (e: unknown) => e instanceof CatalogError && e.code === "invalid" && e.field === "contextWindow",
    );
  });
  it("a __proto__ key in the override set cannot smuggle unvalidated fields", () => {
    const evil = JSON.parse('{"__proto__":{"displayName":"a\\u0007b"}}');
    const c = { ...cat(), models: [model("m")] };
    let outcome: unknown;
    try { outcome = applyOverride(c, { provider: "p1", id: "m", set: evil }, NOW, table, undefined).entry.displayName; } catch (e) { outcome = e; }
    assert.ok(outcome instanceof CatalogError && outcome.code === "invalid", `expected CatalogError invalid, got ${String(outcome)}`);
  });
  it("unknown override keys are invalid", () => {
    const c = { ...cat(), models: [model("m")] };
    assert.throws(() => applyOverride(c, { provider: "p1", id: "m", set: { foo: 1 } as never }, NOW, table, undefined), (e: unknown) => e instanceof CatalogError && e.code === "invalid");
  });
});
