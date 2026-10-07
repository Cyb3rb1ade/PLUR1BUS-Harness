import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.ts";

test("the public surface is exactly what the docs promise", () => {
  for (const name of ["createEmbeddingAdapter", "createRerankAdapter", "egressHosts", "probe", "identityHash", "toFingerprint", "AdapterError", "ConfigError", "RERANK_SHAPES", "renderRerankMappingTable"]) {
    assert.ok(name in api, name);
  }
  assert.deepEqual([...api.ADAPTER_ERROR_KINDS].sort(), ["aborted", "auth", "bad_response", "invalid_request", "network", "overloaded", "rate_limit", "timeout", "too_large"]);
});
