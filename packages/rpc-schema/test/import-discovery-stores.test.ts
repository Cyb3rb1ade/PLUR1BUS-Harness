import { it } from "node:test";
import assert from "node:assert/strict";
import { validateResult } from "../src/index.ts";

it("discloses standalone discovered stores with closed metadata and optional source association", () => {
  const store = { id: "a179a736-9f21-49f7-9e4b-32f63dd9e93d", displayName: "Discovered store", path: "/home/demo/.plur1bus/state/lancedb" };
  const result = { discovery: true, candidates: [], stores: [store], warnings: [] };
  assert.equal(validateResult("admin.import.detect", result).ok, true);
  assert.equal(validateResult("admin.import.detect", { ...result, stores: [{ ...store, value: "private-canary" }] }).ok, false);
  assert.equal(validateResult("admin.import.detect", { ...result, stores: [{ ...store, candidateId: "not-an-id" }] }).ok, false);
  assert.equal(validateResult("admin.import.detect", { ...result, stores: Array(257).fill(store) }).ok, false);
});
