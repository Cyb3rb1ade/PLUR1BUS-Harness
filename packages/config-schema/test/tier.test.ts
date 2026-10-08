import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG_SCHEMA, defaults, filterConfigByTier, filterSchemaByTier, tierOf } from "../src/index.ts";

/** Every schema node reachable via `properties` or an object `additionalProperties`, including the
 * root, so an annotated node with no `x-restart`/`x-tier` still surfaces (see the assertion below). */
function walkNodes(node: any, out: any[]): void {
  if (!node || typeof node !== "object") return;
  out.push(node);
  if (node.properties) for (const v of Object.values<any>(node.properties)) walkNodes(v, out);
  if (node.additionalProperties && typeof node.additionalProperties === "object") walkNodes(node.additionalProperties, out);
}

describe("x-tier", () => {
  it("every node that declares x-restart declares x-tier (basic|advanced) and vice versa", () => {
    const nodes: any[] = [];
    walkNodes(CONFIG_SCHEMA, nodes);
    assert.ok(nodes.length >= 20);
    for (const node of nodes) {
      const hasRestart = "x-restart" in node;
      const hasTier = "x-tier" in node;
      assert.equal(hasTier, hasRestart, `x-restart/x-tier mismatch on ${JSON.stringify(node).slice(0, 80)}`);
      if (hasTier) assert.match(node["x-tier"], /^(basic|advanced)$/);
    }
  });

  it("tierOf follows G16", () => {
    assert.equal(tierOf("agents.bernd.displayName"), "basic");
    assert.equal(tierOf("embedding.useClass"), "basic");
    assert.equal(tierOf("engine.chatModels"), "advanced");
    assert.equal(tierOf("engine.recall.softBudgetMs"), "advanced");
    assert.equal(tierOf("nope.nothing"), "advanced");
  });

  it("filterSchemaByTier basic keeps agents, embedding.useClass, providers, modelRoles only", () => {
    const f = filterSchemaByTier(CONFIG_SCHEMA, "basic");
    assert.deepEqual(Object.keys(f.properties).sort(), ["agents", "embedding", "modelRoles", "providers"]);
    assert.deepEqual(Object.keys(f.properties.embedding.properties), ["useClass"]);
    assert.deepEqual(f.required, []);
  });

  it("filterConfigByTier(defaults(), 'advanced') has no agents key", () => {
    const c = filterConfigByTier(defaults(), "advanced");
    assert.equal("agents" in c, false);
  });

  it("tier-cases.json matches tierOf and the filters (run pnpm gen after a schema change)", () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/tier-cases.json", import.meta.url), "utf8"));
    for (const { key, tier } of fixture.cases) assert.equal(tierOf(key), tier, key);
    assert.deepEqual(fixture.filtered.basic, filterSchemaByTier(CONFIG_SCHEMA, "basic"));
    assert.deepEqual(fixture.filtered.advanced, filterSchemaByTier(CONFIG_SCHEMA, "advanced"));
  });
});
