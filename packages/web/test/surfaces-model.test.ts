import { test } from "node:test";
import assert from "node:assert/strict";
import {
  outputReference,
  imageUrl,
  filterOutputs,
} from "../src/pages/surfaces/data.ts";
test("inline images accept store ids only, never provider URLs or paths", () => {
  assert.equal(
    outputReference({
      id: "00000000-0000-4000-8000-000000000001",
      files: [{ format: "png" }],
    }),
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(
    outputReference({
      isError: false,
      value: {
        id: "00000000-0000-4000-8000-000000000001",
        files: [{ format: "png" }],
      },
      truncated: false,
    }),
    "00000000-0000-4000-8000-000000000001",
  );
  for (const value of [
    { url: "https://provider.invalid/image" },
    { id: "../../secret", files: [{}] },
    null,
  ])
    assert.equal(outputReference(value), null);
});
test("display accepts image MIME whitelist and base64 only", () => {
  assert.equal(
    imageUrl({ data: "UE5H", mimeType: "image/png" }),
    "data:image/png;base64,UE5H",
  );
  assert.equal(imageUrl({ data: "<script>", mimeType: "image/png" }), null);
  assert.equal(imageUrl({ data: "UE5H", mimeType: "text/html" }), null);
});
test("gallery filters agent, adapter, inclusive date", () => {
  const outputs = [
    { id: "1", agentId: "a", createdAt: 100, metadata: { adapter: "fake" } },
    { id: "2", agentId: "b", createdAt: 200, metadata: { adapter: "other" } },
  ];
  assert.deepEqual(
    filterOutputs(outputs, {
      agent: "a",
      adapter: "fake",
      after: 100,
      before: 100,
    }).map((o) => o.id),
    ["1"],
  );
});
