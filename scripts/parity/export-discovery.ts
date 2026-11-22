import { fileURLToPath } from "node:url";
import { resolveRole, roleWarnings } from "../../packages/core/src/discovery/roles.ts";
import { emptyCatalog, type CatalogModel } from "../../packages/core/src/discovery/types.ts";
import { exporterMain } from "./lib.mjs";

export function captureRoles() {
  const make = (provider: string, id: string, status: CatalogModel["status"], aliases: string[] = []): CatalogModel => ({
    provider, id, status, aliases, displayName: id, kind: "chat", capabilities: [],
    firstSeen: "2026-11-18T00:00:00Z", lastSeen: "2026-11-19T00:00:00Z",
    source: status === "manual" ? "manual" : "scan", overrides: {},
  });
  const models = [
    make("vendor", "region/preferred", "available"),
    make("vendor/region", "preferred", "manual", ["short"]),
    make("vendor/region", "gone", "unavailable"),
    make("other", "alternative", "available", ["gone"]),
    make("vendor", "archived", "unavailable", ["short"]),
    make("vendor", "later", "available", ["archived"]),
    make("other", "other-gone", "unavailable"),
  ];
  const catalog = { ...emptyCatalog("public-fixture"), models };
  const selectors = ["vendor/region/preferred", "vendor/region/gone", "gone", "short",
    "archived", "vendor/archived", "vendor/missing", "other-gone", ""];
  const roles = { chat: "vendor/region/preferred", decision: "vendor/region/gone", light: "other-gone" };
  return { roles: { models, selectors: selectors.map(selector => ({ selector, result: resolveRole(selector, catalog) })),
    roles: Object.entries(roles), warnings: [undefined, "vendor/region", "vendor"]
      .map(provider => ({ provider: provider ?? null, result: roleWarnings(catalog, roles, provider) })) } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "discovery", build: captureRoles });
}
