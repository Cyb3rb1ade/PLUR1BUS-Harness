/** M-A8: a remote sign-in requirement reaches the registry's metadata-only diagnostic event. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { caller, capturingLogger } from "./helpers/util.ts";

it("a remote 401 becomes auth-required in status and the observer without challenge material", async () => {
  const server = createServer((_request, response) => response.writeHead(401, {
    "www-authenticate": 'Bearer error_description="fixture-secret-never-print"',
  }).end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const logger = capturingLogger();
  const events: unknown[] = [];
  const registry = new McpRegistry({ logger, onEvent: event => events.push(event) });
  try {
    registry.register({ name: "signin", transport: { type: "http", url }, timeouts: { connectMs: 5000 } });
    await assert.rejects(registry.listTools("signin", caller), error => {
      assert.equal((error as { code?: string }).code, "auth-required");
      return true;
    });
    assert.equal(registry.status("signin", caller.agentId).lastError?.code, "auth-required");
    assert.ok(events.some(event => (event as { params?: { reason?: string } }).params?.reason === "auth-required"));
    assert.equal(JSON.stringify({ events, status: registry.status("signin", caller.agentId), log: logger.text() })
      .includes("fixture-secret-never-print"), false);
  } finally {
    await registry.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
