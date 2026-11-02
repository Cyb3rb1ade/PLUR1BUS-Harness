/** Child-process contract: the managed 16 KiB limit must hold independently of Node's larger startup default. */
import assert from "node:assert/strict";
import { createUnixFetch, ProviderError } from "../../src/index.ts";
import { startFakeFmServe } from "./fake-fm-serve.ts";

const fm = await startFakeFmServe({ handler: (_request, response) => {
  response.writeHead(200, { "content-type": "application/json", "x-synthetic-header": "x".repeat(20 * 1024) });
  response.end("{}");
} });
try {
  const fetch = createUnixFetch(fm.socket, { guard: { verify: () => ({ ok: true }) } });
  await assert.rejects(fetch("http://apple-fm.invalid/health"), (error: unknown) =>
    error instanceof ProviderError && error.kind === "network" && error.code === "unavailable" && !error.retryable);
  await fm.waitForDisconnect();
  assert.equal(fm.connections(), 0);
} finally {
  await fm.close();
}
