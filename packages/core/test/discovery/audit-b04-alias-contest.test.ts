// Audit b04 (model discovery): alias-contest.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { reconcile } from "../../src/discovery/reconcile.ts";
import { emptyCatalog } from "../../src/discovery/types.ts";
import type { CatalogModel } from "../../src/discovery/types.ts";

const table = loadMetadataTable();
const NOW = "2026-10-14T10:00:00.000Z";
const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  provider: "p1", id, displayName: id, kind: "chat", capabilities: [], aliases: [], status: "available",
  firstSeen: NOW, lastSeen: NOW, source: "scan", overrides: {}, ...extra,
});

describe("b04: alias contest", () => {
  const ct = loadMetadataTable({
    schema: "plur1bus.model-metadata/1", revision: "b04",
    vendors: { v: [{ pattern: "^col-.*$", kind: "chat", capabilities: [], aliases: ["col"] }] },
  });
  it("an available model keeps the alias against an unavailable one", () => {
    const base = model("col", { status: "unavailable", aliases: ["col"], source: "table" });
    const res = reconcile({ catalog: { ...emptyCatalog(ct.revision), models: [base] }, provider: "p1", raw: [{ id: "col-2026-01-01" }], now: NOW, table: ct, vendor: "v", roles: {} });
    const dated = res.catalog.models.find((m) => m.id === "col-2026-01-01")!;
    const old = res.catalog.models.find((m) => m.id === "col")!;
    assert.deepEqual(dated.aliases, ["col"]);
    assert.deepEqual(old.aliases, []);
  });
  it("a user-set alias is not taken away by a table alias", () => {
    const mine = model("my-model", { aliases: ["col"], overrides: { aliases: ["col"] } });
    const res = reconcile({ catalog: { ...emptyCatalog(ct.revision), models: [mine] }, provider: "p1", raw: [{ id: "my-model" }, { id: "col-1", created: 9_999_999_999_999 }], now: NOW, table: ct, vendor: "v", roles: {} });
    assert.deepEqual(res.catalog.models.find((m) => m.id === "my-model")!.aliases, ["col"]);
    assert.deepEqual(res.catalog.models.find((m) => m.id === "col-1")!.aliases, []);
  });
});
