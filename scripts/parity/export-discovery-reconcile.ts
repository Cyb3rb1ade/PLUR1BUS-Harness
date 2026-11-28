import { fileURLToPath } from "node:url";
import { loadMetadataTable, reenrichCatalog } from "../../packages/core/src/discovery/metadata.ts";
import { applyOverride, CatalogError } from "../../packages/core/src/discovery/overrides.ts";
import type { SetOverride } from "../../packages/core/src/discovery/overrides.ts";
import { reconcile } from "../../packages/core/src/discovery/reconcile.ts";
import { emptyCatalog } from "../../packages/core/src/discovery/types.ts";
import type { CatalogFile, CatalogModel, RawEntry } from "../../packages/core/src/discovery/types.ts";
import { exporterMain } from "./lib.mjs";

const now1 = "2026-11-22T09:00:00.000Z";
const now2 = "2026-11-22T10:00:00.000Z";
const provider = "fixture";
const vendor = "example-vendor";

export function recordDiscoveryReconcile() {
  const table = loadMetadataTable();
  const start = emptyCatalog(table.revision);
  const roles = { chat: "fixture/example-chat-large", embeddings: "fixture/example-embed-gone" };
  const cases: unknown[] = [];
  const run = (name: string, catalog: CatalogFile, raw: RawEntry[], key = provider, now = now2) => {
    const input = { catalog: structuredClone(catalog), provider: key, raw, now, vendor, roles };
    try {
      const expected = reconcile({ ...input, table });
      cases.push({ name, input: { ...input, roles: Object.entries(roles) }, expected: structuredClone(expected) });
      return expected.catalog;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      cases.push({ name, input: { ...input, roles: Object.entries(roles) }, expected: { error: error.message } });
      return catalog;
    }
  };

  const other = run("first-provider", start, [{ id: "other-model" }], "other", now1);
  const base = run("vendor-generic-and-heuristic", other, [
    { id: "example-chat-large", displayName: "Large API" },
    { id: "example-embed-gone" },
    { id: "fixture-whisper-a1" },
    { id: "unknown" },
  ], provider, now1);

  base.models.find((model) => model.id === "example-chat-large")!.overrides = {
    displayName: "My Large", aliases: ["my-chat"], capabilities: ["structured_output"],
  };
  const manual: CatalogModel = {
    provider, id: "manual-model", displayName: "Manual", status: "manual", source: "manual",
    kind: "chat", firstSeen: now1, lastSeen: now1, overrides: {}, capabilities: [], aliases: [],
  };
  base.models.push(manual);
  const next = run("update-remove-manual-and-duplicates", base, [
    { id: "example-chat-large", kind: "chat", displayName: "Revised", contextWindow: 32768 },
    { id: "manual-model", displayName: "Must be shadowed" },
    { id: "new-model", displayName: "First" },
    { id: "new-model", displayName: "Last", reasoning: { style: "openrouter", supported: true } },
  ]);
  run("reappearance", next, [{ id: "example-embed-gone", contextWindow: 512 }, { id: "new-model" }]);
  run("empty-list-is-never-a-scan", next, []);

  const aliasContest: CatalogFile = {
    ...start,
    models: [
      { ...manual, id: "a-model", source: "scan", aliases: ["shared"], status: "available" },
      { ...manual, id: "B-model", source: "scan", aliases: ["shared"], status: "available" },
      { ...manual, id: "model-20250101", source: "manual", aliases: ["version"] },
      { ...manual, id: "model-2026-01-01", source: "manual", aliases: ["version"] },
    ],
  };
  run("compare-root-locale-and-date", aliasContest, [{ id: "unchanged" }], "other");
  run("repeat-alias-in-manual-entry", {
    ...start,
    models: [{ ...manual, aliases: ["repeated", "repeated", "unique"] }],
  }, [{ id: "unchanged" }], "other");

  run("created-wins-for-two-live-override-aliases", {
    ...start,
    models: aliasContest.models.slice(0, 2).map((model) => ({ ...model, overrides: { aliases: ["shared"] } })),
  }, [
    { id: "a-model", created: 100 },
    { id: "B-model", created: 200 },
  ]);
  run("user-alias-outranks-newer-table-alias", {
    ...start,
    models: [{
      ...aliasContest.models[0]!,
      overrides: { aliases: ["example-chat-latest"] },
    }],
  }, [
    { id: "a-model", created: 100 },
    { id: "example-chat-large", created: 200 },
  ]);
  const catalog = structuredClone(base);
  const id = "example-chat-large";
  const overrideRequests = [
    { name: "manual-create", request: { provider, id: "manual-new", create: true, set: { aliases: ["local-alias"], kind: "tts" } } },
    { name: "table-refresh", request: { provider, id, clear: "all", set: { displayName: "Renamed" } } },
    { name: "manual-reset", request: { provider, id: "manual-model", clear: "all", set: { displayName: "My manual model", capabilities: ["tools"] } } },
    { name: "alias-conflict", request: { provider, id, set: { aliases: ["manual-model"] } } },
    { name: "repeated-alias", request: { provider, id, set: { aliases: ["same", "same"] } } },
    { name: "invalid-override-key", request: { provider, id, set: { ignoredField: "value" } } },
    { name: "empty-display", request: { provider, id, set: { displayName: "" } } },
    { name: "invalid-clear", request: { provider, id, clear: ["invented"] } },
    { name: "missing-model", request: { provider, id: "absent", set: { kind: "tts" } } },
  ];
  const overrides = overrideRequests.map(({ name, request }) => {
    const input = { catalog, request, now: now2, vendor };
    try {
      return { name, input, expected: applyOverride(catalog, request as SetOverride, now2, table, vendor) };
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      return { name, input, expected: { code: error.code, field: error.field } };
    }
  });
  const tableInput = { schema: "plur1bus.model-metadata/1", revision: "fixture-revision", vendors: {
    "example-vendor": [{ pattern: "^example-chat-large$", kind: "chat", contextWindow: 29000, capabilities: ["vision"] }],
  } };
  const refreshed = { input: { catalog: base, table: tableInput, vendor }, expected: reenrichCatalog(base, loadMetadataTable(tableInput), () => vendor) };
  const patterns = ["^example-[0-9]+$", "not-anchored", "^(lo{2}){2}$"].map(pattern => {
    const input = { ...tableInput, vendors: { generic: [{ pattern, kind: "chat", capabilities: [] }] } };
    try { loadMetadataTable(input); return { input, valid: true }; } catch { return { input, valid: false }; }
  });
  return { reconcile: { source: "packages/core/src/discovery/reconcile.ts", cases, overrides, refreshed, patterns } };

}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "discovery", build: recordDiscoveryReconcile });
}
