/** Default target model disclosure uses actual host metadata and never widens a device session's model authority. */
import assert from "node:assert/strict";
import test from "node:test";
import { currentImportTarget } from "../src/pages/import/store-models.ts";

test("current target comes from the actual model status and retains only its embedding metadata", async () => {
  const calls: unknown[] = [];
  const value = await currentImportTarget({
    rpc: async (...args) => {
      calls.push(args);
      return {
        embedding: { provider: "local-transformers", model: "actual-model", dimensions: 768, configured: true },
        reranker: { provider: "private-other-field" },
        embeddingSwitch: "allowed",
      };
    },
  });
  assert.deepEqual(value, {
    authorityDenied: false,
    embedding: { provider: "local-transformers", model: "actual-model", dimensions: 768, configured: true },
  });
  assert.deepEqual(calls, [["model.memory.status", {}, { write: false }]]);
});
test("import-only scope denial yields ordinary-session guidance without synthesizing a target or making another call", async () => {
  let calls = 0;
  const value = await currentImportTarget({
    rpc: async () => {
      calls++;
      throw { kind: "rpc-error", errorCode: "E_DENIED" };
    },
  });
  assert.deepEqual(value, { authorityDenied: true });
  assert.equal(calls, 1);
  await assert.rejects(
    currentImportTarget({
      rpc: async () => {
        throw { kind: "rpc-error", errorCode: "E_CORE_UNAVAILABLE" };
      },
    }),
  );
  await assert.rejects(
    currentImportTarget({
      rpc: async () => ({
        embedding: { provider: "local-transformers", model: "invented", dimensions: -1, configured: true },
      }),
    }),
  );
});
