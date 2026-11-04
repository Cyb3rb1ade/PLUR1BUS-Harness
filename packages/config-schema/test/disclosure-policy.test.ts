// The same capability vectors run in Rust: unsupported metadata must never become a raw public fallback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as config from "../src/index.ts";
const vectors = JSON.parse(readFileSync(new URL("./fixtures/disclosure-policies.json", import.meta.url), "utf8")) as
  { name: string; supported: boolean; schema: unknown }[];

test("module disclosure policies share the Rust direct-member capability boundary", () => {
  assert.equal(typeof config.supportsConfigDisclosurePolicy, "function");
  for (const vector of vectors) assert.equal(config.supportsConfigDisclosurePolicy(vector.schema), vector.supported, vector.name);
});
