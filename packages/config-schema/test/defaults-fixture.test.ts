import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaults } from "../src/index.ts";

it("fixtures/defaults.json is the committed defaults (run pnpm gen after a schema change)", () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL("../fixtures/defaults.json", import.meta.url), "utf8")), defaults());
});
