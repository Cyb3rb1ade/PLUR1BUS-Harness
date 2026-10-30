/** Sealing preserves inert import disclosures while removing every supported source credential transport. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sealSourceConfiguration } from "../../src/import/source-seal.ts";
import { parseImportedMcpConfig } from "../../src/import/mcp-config.ts";

test("source MCP values are withheld while required slots, runtime and manual reasons remain identical", () => {
  const marker = "SOURCE-PRIVATE-CREDENTIAL-MARKER";
  const config = { meta: { lastTouchedVersion: "2026.9.5" }, apiKey: { value: marker }, mcp: { servers: {
    local: { command: `/private/${marker}/node`, args: ["--token", marker], cwd: `/private/${marker}`, env: { SOURCE_KEY: marker } },
    remote: { url: "https://example.test/mcp", headers: { Authorization: marker } },
    reference: { url: "https://example.test/other", headers: { Authorization: "Bearer ${TOKEN}" } },
    query: { url: `https://example.test/private?token=${marker}` },
    invalid: { url: `not-a-url ${marker}` },
    requester: { url: "https://example.test/oauth", auth: { type: "oauth", codeVerifier: marker }, oauth: { authorizationCode: marker } },
  } } };
  const bytes = sealSourceConfiguration("openclaw.json", Buffer.from(JSON.stringify(config)));
  assert.equal(bytes.includes(Buffer.from(marker)), false);
  const sealed = JSON.parse(bytes.toString());
  assert.deepEqual(parseImportedMcpConfig({ source: "openclaw", config: sealed }), parseImportedMcpConfig({ source: "openclaw", config }));
});
