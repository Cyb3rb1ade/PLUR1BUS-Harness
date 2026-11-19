import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIG_SCHEMA } from "@plur1bus/config-schema";
import { engineSecretNames } from "../../src/engine/secret-scope.ts";
import { isSecretName } from "../../src/secrets/types.ts";

// The vectors are shared with the Rust front door (`crates/plur1bus-core/src/engine_scope.rs` replays the same file).
interface Vector { name: string; config: unknown; names: string[] }
const vectors = JSON.parse(readFileSync(new URL("../../../../fixtures/parity/secrets/engine-scope.json", import.meta.url), "utf8")) as { cases: Vector[] };

for (const v of vectors.cases) {
  test(`engine secret scope: ${v.name}`, () => {
    assert.deepEqual([...engineSecretNames(v.config)].sort(), v.names);
  });
}

test("every default name of the schema is a valid secret name and sits on a block", () => {
  const found: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "x-secret-default") {
        assert.match(path, /^\/properties\/engine\/x-value-schema\/properties\/[A-Za-z0-9]+$/u, "the mark sits on a block of the engine's configuration");
        assert.ok(Array.isArray(child) && child.length > 0);
        for (const name of child as unknown[]) { assert.equal(isSecretName(name), true, String(name)); found.push(String(name)); }
      } else visit(child, `${path}/${key}`);
    }
  };
  visit(CONFIG_SCHEMA, "");
  assert.deepEqual(found.sort(), ["COHERE_API_KEY", "JINA_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "VOYAGE_API_KEY"]);
});

test("the schema accepts its own default marks and a configuration validates with them", async () => {
  const { validate, defaults } = await import("@plur1bus/config-schema");
  const config = { ...defaults(), engine: { implementation: "node", embedding: { apiKeyRef: "embedding-key" } } };
  const result = validate(config);
  assert.equal(result.ok, true, JSON.stringify(result));
});
