import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/api/index.ts";

test("file upload sends real multipart bytes with a fresh CSRF token and lets fetch select the boundary", async () => {
  const requests: RequestInit[] = [];
  const api = createApi({
    csrf: async () => "one-use-csrf",
    fetch: async (_input, init) => {
      requests.push(init!);
      return new Response(JSON.stringify({ uploadId: "A".repeat(43), expiresAt: 600000, sha256: "a".repeat(64) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(typeof api.upload, "function");
  const result = await api.upload!("/api/v1/extensions/upload", new Blob(["actual-file-bytes"]), "safe.p1x");
  assert.equal((result as { uploadId: string }).uploadId, "A".repeat(43));
  assert.equal(requests.length, 1);
  const request = requests[0]!,
    headers = new Headers(request.headers);
  assert.equal(headers.get("x-csrf-token"), "one-use-csrf");
  assert.equal(headers.has("content-type"), false);
  assert.ok(request.body instanceof FormData);
  const file = request.body.get("file") as File;
  assert.equal(file.name, "safe.p1x");
  assert.equal(await file.text(), "actual-file-bytes");
  assert.equal(request.credentials, "same-origin");
});
