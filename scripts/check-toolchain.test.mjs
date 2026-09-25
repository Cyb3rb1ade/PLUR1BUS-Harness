import { test } from "node:test";
import assert from "node:assert/strict";
import { checkToolchain } from "./check-toolchain.mjs";

test("accepts node 24.16+, pnpm 10+, cargo 1.95+", () => {
  const ok = checkToolchain({ node: "v24.21.0", pnpm: "10.28.0", cargo: "cargo 1.95.0 (f2d3ce0bd 2026-03-21)" });
  assert.deepEqual(ok, { ok: true, problems: [] });
});

test("names every tool that is too old", () => {
  const bad = checkToolchain({ node: "v22.22.2", pnpm: "9.1.0", cargo: "cargo 1.80.0" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => p.tool), ["node", "pnpm", "cargo"]);
});
