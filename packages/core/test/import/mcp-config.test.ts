// A13 pure source mapping keeps credential material and source-supplied trust out of native import candidates.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseImportedMcpConfig } from "../../src/import/mcp-config.ts";

const MARKER = "A13_DO_NOT_COPY_SECRET_VALUE";

describe("imported MCP configuration (A13)", () => {
  it("normalizes both source maps to stable candidates without adopting source trust", () => {
    const server = { url: "https://tools.example/mcp", enabled: true, trust: "first-party", package: MARKER,
      signer: MARKER, capabilitiesAck: MARKER, id: MARKER };
    for (const source of ["openclaw", "hermes"] as const) {
      const config = source === "openclaw" ? { mcp: { servers: { search: server } } } : { mcp_servers: { search: server } };
      const candidates = parseImportedMcpConfig({ source, profile: "Work", config });
      assert.equal(candidates.length, 1);
      const candidate = candidates[0]!;
      assert.equal(candidate.schema, "import.mcp-candidate/1");
      assert.equal(candidate.source, source);
      assert.equal(candidate.profile, "work");
      assert.match(candidate.name, /^[a-z][a-z0-9-]{0,61}$/);
      assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
      assert.deepEqual(candidate.transport, { type: "http", url: "https://tools.example/mcp", auth: "none" });
      assert.deepEqual(parseImportedMcpConfig({ source, profile: "Work", config }), candidates);
      for (const field of ["trust", "enabled", "package", "signer", "capabilitiesAck", "id"]) {
        assert.equal(field in candidate, false, field);
      }
      assert.equal(JSON.stringify(candidates).includes(MARKER), false);
    }
  });

  it("withholds local argv, environment and cwd values and describes an inert manual setup", () => {
    const [candidate] = parseImportedMcpConfig({ source: "openclaw", config: { mcp: { servers: { local: {
      command: "npx", args: ["-y", "package", "--token", MARKER], cwd: MARKER,
      env: { API_TOKEN: MARKER, OPENAI_API_KEY: "${AMBIENT_KEY}" }, headers: { Authorization: MARKER },
    } } } } });
    assert.ok(candidate);
    assert.deepEqual(candidate.transport, { type: "manual", runtime: "node" });
    assert.ok(candidate.reasons.includes("external-command-manual-setup"));
    assert.deepEqual(candidate.requiredSecrets, [{ slot: "API_TOKEN" }, { slot: "AUTHORIZATION" },
      { slot: "OPENAI_API_KEY" }]);
    const serialized = JSON.stringify(candidate);
    for (const value of [MARKER, "${AMBIENT_KEY}", "--token", "package"]) assert.equal(serialized.includes(value), false);
  });

  it("refuses credential-bearing remote URLs and shared conversion of requester OAuth", () => {
    for (const server of [
      { url: `https://user:${MARKER}@tools.example/mcp` },
      { url: `https://tools.example/mcp?token=${MARKER}` },
      { url: "https://tools.example/mcp", auth: "oauth", oauth: { client_secret: MARKER } },
    ]) {
      const [candidate] = parseImportedMcpConfig({ source: "hermes", config: { mcp_servers: { remote: server } } });
      assert.ok(candidate);
      assert.equal(candidate.transport.type, "manual");
      assert.equal(JSON.stringify(candidate).includes(MARKER), false);
    }
  });

  it("maps a remote bearer to a declared slot without resolving an ambient reference", () => {
    const [candidate] = parseImportedMcpConfig({ source: "hermes", config: { mcp_servers: { search: {
      url: "https://tools.example/mcp", headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
    } } } });
    assert.ok(candidate);
    assert.deepEqual(candidate.transport, { type: "http", url: "https://tools.example/mcp", auth: "header" });
    assert.deepEqual(candidate.requiredSecrets, [{ slot: "SEARCH_TOKEN" }]);
    assert.equal(JSON.stringify(candidate).includes("${SEARCH_TOKEN}"), false);
  });

  it("keeps profile identities distinct and ignores source object ordering and credential-value changes", () => {
    const config = (value: string) => ({ mcp_servers: { search: { env: { TOKEN: value }, command: "uvx" } } });
    const a = parseImportedMcpConfig({ source: "hermes", profile: "Work", config: config(MARKER) })[0]!;
    const b = parseImportedMcpConfig({ source: "hermes", profile: "work", config: config("different") })[0]!;
    const c = parseImportedMcpConfig({ source: "hermes", profile: "Work", config: config("different") })[0]!;
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.notEqual(a.name, b.name);
    assert.deepEqual(a, c);
  });

  it("refuses control characters in secret slot names and authorization references", () => {
    const [candidate] = parseImportedMcpConfig({ source: "hermes", config: { mcp_servers: { search: {
      command: "node", env: { "TOKEN\n": MARKER, "OK_TOKEN": MARKER },
      headers: { Authorization: "Bearer ${TOKEN}\n" },
    } } } });
    assert.deepEqual(candidate!.requiredSecrets, [{ slot: "AUTHORIZATION" }, { slot: "OK_TOKEN" }]);
    assert.ok(candidate!.reasons.includes("invalid-secret-slot-manual-setup"));
  });

  it("refuses oversized server and slot maps instead of silently truncating them", () => {
    for (const config of [
      { mcp_servers: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`server${i}`, {}])) },
      { mcp_servers: { local: { command: "node", env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`TOKEN_${i}`, MARKER])) } } },
    ]) {
      assert.throws(() => parseImportedMcpConfig({ source: "hermes", config }), (error: any) =>
        error.reason === "extension-source-limit" && !String(error).includes(MARKER));
    }
  });
});
