/** Discovered store selection remains an opaque replacement read authority, never a free host path. */
import assert from "node:assert/strict";
import test from "node:test";
import { importMappingsReady, storeReplacement } from "../src/pages/import/store-mappings.ts";

const id = "12345678-1234-4123-8123-123456789011";
const stores = [{ id, displayName: "Discovered memory", path: "/remote/standalone-memory" }];
test("an explicit original source path and known store ID can replace a read location for remote Admin", () => {
  const to = storeReplacement(id, stores);
  assert.equal(to, `store:${id}`);
  assert.equal(importMappingsReady([{ from: "/old/source-memory", to }], stores, false), true);
  assert.equal(importMappingsReady([{ from: "", to }], stores, false), false);
  assert.equal(importMappingsReady([{ from: "relative", to }], stores, false), false);
  assert.equal(importMappingsReady([{ from: "/old/source-memory", to: stores[0]!.path }], stores, false), false);
  assert.equal(importMappingsReady([{ from: "/old/source-memory", to: "/owner/replacement" }], stores, true), true);
});
test("unknown or stale store IDs and duplicate original paths cannot become mapping requests", () => {
  assert.throws(() => storeReplacement("not-an-id", stores));
  assert.throws(() => storeReplacement("12345678-1234-4123-8123-123456789099", stores));
  assert.equal(importMappingsReady([{ from: "/original", to: `store:${id}` }], [], true), false);
  assert.equal(importMappingsReady([{ from: "/original", to: "" }], stores, true), false);
  assert.equal(
    importMappingsReady(
      [
        { from: "/original", to: `store:${id}` },
        { from: "/original", to: "/other" },
      ],
      stores,
      true,
    ),
    false,
  );
  assert.equal(importMappingsReady([], stores, false), true);
});

test("adoption selects only an actual store from the inspected source metadata", async () => {
  const { sourceStoreReady } = await import("../src/pages/import/store-mappings.ts");
  const source = [{ id: "actual-store", displayName: "Source memory", kind: "shared" as const, rows: 12 }];
  assert.equal(sourceStoreReady(undefined, source), true);
  assert.equal(sourceStoreReady("actual-store", source), true);
  assert.equal(sourceStoreReady("guessed-store", source), false);
  assert.equal(sourceStoreReady("actual-store", undefined), false);
});
