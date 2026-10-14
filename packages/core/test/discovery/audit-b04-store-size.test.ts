// Audit b04 (model discovery): store-size.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createCatalogStore, CatalogWriteError } from "../../src/discovery/catalog-store.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { FakeClock } from "../../src/discovery/testing.ts";
import type { CatalogModel } from "../../src/discovery/types.ts";

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

describe("b04: catalog store size", () => {
  it("refuses to write a catalog that load() would then reject as larger than 16 MiB", async () => {
    const { store } = mkStore();
    const big = (i: number) => model(`m-${i}`, { displayName: "d".repeat(500), aliases: Array.from({ length: 16 }, (_, k) => `a-${i}-${k}-${"x".repeat(480)}`) });
    const models = Array.from({ length: 2400 }, (_, i) => big(i));
    await assert.rejects(store.mutate((c) => ({ next: { ...c, models }, result: 0 })), (e: unknown) => e instanceof CatalogWriteError);
    assert.equal(store.read().models.length, 0, "memory unchanged");
  });
});
