import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coreAddress } from "../src/paths.ts";

// The shared address vectors (HM2 Task 2, F22): hand-committed, hashes computed independently of every
// implementation, and read unchanged by the Python client (test_paths.py), paths.rs
// (`address_matches_the_shared_vectors`) and this test.
const vectorsUrl = new URL("../../../clients/python/plur1bus-memory-client/tests/fixtures/address-vectors.json", import.meta.url);
const vectors: { home: string; platform: NodeJS.Platform; address: string }[] = JSON.parse(readFileSync(vectorsUrl, "utf8"));

describe("shared address vectors (parity with paths.rs and the Python client)", () => {
  it("coreAddress matches every vector", () => {
    assert.ok(vectors.length >= 10);
    for (const v of vectors) assert.equal(coreAddress(v.home, v.platform), v.address, `${v.platform} ${JSON.stringify(v.home)}`);
  });
});
