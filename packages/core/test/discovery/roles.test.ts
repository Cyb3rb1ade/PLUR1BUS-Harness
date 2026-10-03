import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveRole, roleWarnings } from "../../src/discovery/roles.ts";
import { emptyCatalog } from "../../src/discovery/types.ts";
import type { CatalogFile, CatalogModel } from "../../src/discovery/types.ts";

const vectors: {
  name: string;
  catalog: { provider: string; id: string; aliases: string[]; status: string }[];
  value: string;
  expect: { provider: string; id: string; state: "available" | "unavailable" } | null;
}[] = JSON.parse(readFileSync(new URL("../fixtures/discovery/role-vectors.json", import.meta.url), "utf8"));

function toCatalogFile(items: { provider: string; id: string; aliases: string[]; status: string }[]): CatalogFile {
  return {
    ...emptyCatalog("r1"),
    models: items.map((m): CatalogModel => ({
      provider: m.provider,
      id: m.id,
      displayName: m.id,
      kind: "chat",
      capabilities: [],
      aliases: m.aliases,
      status: m.status as CatalogModel["status"],
      firstSeen: "t",
      lastSeen: "t",
      source: "scan",
      overrides: {},
    })),
  };
}

describe("roles", () => {
  for (const v of vectors) {
    it(`vector: ${v.name}`, () => {
      const cat = toCatalogFile(v.catalog);
      const res = resolveRole(v.value, cat);
      assert.deepEqual(res, v.expect);
    });
  }

  it("roleWarnings identifies unavailable roles", () => {
    const cat = toCatalogFile([
      { provider: "p1", id: "m-alive", aliases: [], status: "available" },
      { provider: "p1", id: "m-dead", aliases: ["dead-alias"], status: "unavailable" },
      { provider: "p2", id: "m-other-dead", aliases: [], status: "unavailable" },
    ]);

    const roles = {
      chat: "p1/m-alive",
      reasoning: "dead-alias",
      dream: "p2/m-other-dead",
      missing: "unknown-model",
    };

    // All providers
    const allWarnings = roleWarnings(cat, roles);
    assert.deepEqual(allWarnings, [
      { code: "role_unavailable", role: "reasoning", provider: "p1", id: "m-dead" },
      { code: "role_unavailable", role: "dream", provider: "p2", id: "m-other-dead" },
    ]);

    // Scoped to provider p1
    const p1Warnings = roleWarnings(cat, roles, "p1");
    assert.deepEqual(p1Warnings, [
      { code: "role_unavailable", role: "reasoning", provider: "p1", id: "m-dead" },
    ]);
  });
});
