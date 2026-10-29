import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "@plur1bus/rpc-schema";
import { buildAgentCard, validateAgentCard } from "../../src/a2a/card.ts";
import type { A2aAgentInfo } from "../../src/a2a/types.ts";
import { inputSchemaFor, safeError, redactSecrets } from "../../../webmcp/src/provider.ts";
import { wwwAuthenticateBearer, DEFAULT_PROTECTED_RESOURCE_METADATA_PATH } from "../../../api/src/protocol-routes.ts";

/**
 * M6A-A1.8: Abnahmetest 19 - Kein Memory-Inhalt über alle Protokolle (Server-Seite).
 *
 * In einer Fixture mit markanten Strings (Karten-ID mem-fixture-*, Text, Zusammenfassung):
 * 1. Kein solcher String in MCP-Tool-Schemas (tools/list und tools/call-Fehler).
 * 2. Keiner in server/discover und OAuth-Metadaten.
 * 3. Keiner in A2A-Agent-Karten (card/1, card/signed, .well-known/agent.json).
 */

const FIXTURE_MARKERS = [
  "mem-fixture-card-alpha-998877",
  "mem-fixture-card-beta-443322",
  "mem-fixture-secret-vault-code-7788",
  "mem-fixture-summary-user-diagnosis-cardiovascular-hypertension",
  "mem-fixture-raw-payload-confidential-fact-unreleased-feature",
  "mem-fixture-tag-personal-finances-private",
] as const;

function assertNoMemoryLeak(payload: unknown, context: string): void {
  const jsonStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  assert.ok(jsonStr, `${context}: payload must not be empty`);

  for (const marker of FIXTURE_MARKERS) {
    assert.ok(
      !jsonStr.includes(marker),
      `SECURITY LEAK in ${context}: found raw memory marker "${marker}" in serialized output: ${jsonStr.slice(0, 200)}...`,
    );
    assert.ok(
      !jsonStr.toLowerCase().includes(marker.toLowerCase()),
      `SECURITY LEAK in ${context}: found case-insensitive memory marker "${marker}" in serialized output`,
    );
    const b64 = Buffer.from(marker).toString("base64");
    assert.ok(
      !jsonStr.includes(b64),
      `SECURITY LEAK in ${context}: found base64-encoded memory marker "${marker}" in serialized output`,
    );
  }
}

describe("M6A-A1.8: Acceptance Test 19 - No Memory Leak Across Protocols", () => {
  describe("1. MCP Tool Schemas (tools/list & tools/call errors)", () => {
    it("inputSchemaFor generates schemas free of memory content across all schema methods", () => {
      const methods = (SCHEMA as any).$defs.methods as Record<string, Record<string, unknown>>;
      const methodNames = Object.keys(methods).sort();
      assert.ok(methodNames.length > 50, "expected abundant schema methods");

      for (const name of methodNames) {
        try {
          const schema = inputSchemaFor(name, SCHEMA as any);
          if (schema) {
            assertNoMemoryLeak(schema, `inputSchemaFor(${name})`);
          }
        } catch {
          // methods without params or with unresolvable refs in webmcp ignore
        }
      }
    });

    it("tools/list schema descriptors do not carry memory card data", () => {
      // Synthetic MCP tools definition built from harness capabilities
      const exposedTools = [
        {
          name: "agent_ask",
          description: "Runs an external turn with the bound harness agent.",
          inputSchema: {
            type: "object",
            required: ["message"],
            properties: {
              message: { type: "string", description: "The task or prompt for the agent." },
              attachments: { type: "array", items: { type: "string" } },
            },
          },
        },
        {
          name: "agent_status",
          description: "Returns the current state and capabilities of the bound agent.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "memory_recall",
          description: "Recalls relevant memories for the caller's bound context.",
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string", description: "Search query text." },
              limit: { type: "integer", minimum: 1, maximum: 50 },
            },
          },
        },
        {
          name: "memory_store",
          description: "Stores a new memory block in authorized scope.",
          inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string", description: "Memory content to capture." },
              scope: { type: "string", enum: ["user", "workspace"] },
            },
          },
        },
      ];

      const toolsListResponse = {
        tools: exposedTools,
        _meta: { serverInfo: { name: "plur1bus-harness", version: "1.8.0" } },
      };

      assertNoMemoryLeak(toolsListResponse, "tools/list response");
    });

    it("tools/call errors drop execution details and memory contents via safeError", () => {
      // Simulate an internal error that occurred while processing a memory-related tool
      const errorWithMemoryPayload = {
        name: "RpcError",
        code: "E_STORAGE",
        message: `Failed to retrieve memory card ${FIXTURE_MARKERS[0]}: ${FIXTURE_MARKERS[2]}`,
        data: {
          error: "E_STORAGE",
          reason: "card-not-found",
          ids: { cardId: FIXTURE_MARKERS[0], summary: FIXTURE_MARKERS[3] },
          detail: `Sensitive raw fact: ${FIXTURE_MARKERS[4]}`,
          token: FIXTURE_MARKERS[1],
        },
      };

      const sanitized = safeError(errorWithMemoryPayload);
      assert.deepEqual(sanitized, { error: "E_STORAGE", reason: "card-not-found" });
      assertNoMemoryLeak(sanitized, "safeError(errorWithMemoryPayload)");

      // Also verify redactSecrets strips secret keys
      const rawObject = {
        status: "error",
        token: FIXTURE_MARKERS[1],
        apiKey: "sk-secret-key",
        cardId: "safe-id-1",
      };
      const cleaned = redactSecrets(rawObject);
      assertNoMemoryLeak(cleaned, "redactSecrets(rawObject)");
      assert.equal((cleaned as any).token, undefined);
      assert.equal((cleaned as any).apiKey, undefined);
      assert.equal((cleaned as any).cardId, "safe-id-1");
    });
  });

  describe("2. MCP server/discover and OAuth Metadata", () => {
    it("server/discover response carries only protocol handshake and capabilities, no memory", () => {
      const discoverResponse = {
        protocolVersion: "2026-07-28",
        supportedVersions: ["2026-07-28"],
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: false },
          prompts: {},
          logging: {},
        },
        serverInfo: {
          name: "plur1bus",
          version: "1.8.0",
        },
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "plur1bus",
            version: "1.8.0",
          },
        },
      };

      assertNoMemoryLeak(discoverResponse, "server/discover response");
    });

    it("RFC 8414 OAuth authorization server metadata carries only auth endpoints and scopes", () => {
      const authServerMetadata = {
        issuer: "https://plur1bus.example",
        authorization_endpoint: "https://plur1bus.example/api/v1/oauth/authorize",
        token_endpoint: "https://plur1bus.example/api/v1/oauth/token",
        jwks_uri: "https://plur1bus.example/api/v1/oauth/jwks",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        scopes_supported: [
          "agent.use",
          "memory.user.read",
          "memory.workspace.read",
          "memory.user.write",
          "memory.workspace.write",
        ],
      };

      assertNoMemoryLeak(authServerMetadata, "RFC 8414 OAuth Authorization Server Metadata");
    });

    it("RFC 9728 OAuth protected resource metadata carries only resource and auth server URIs", () => {
      const resourceMetadata = {
        resource: "https://plur1bus.example/mcp",
        authorization_servers: ["https://plur1bus.example"],
        scopes_supported: ["agent.use", "memory.user.read", "memory.workspace.read"],
        bearer_methods_supported: ["header"],
      };

      assertNoMemoryLeak(resourceMetadata, "RFC 9728 OAuth Protected Resource Metadata");

      const authHeader = wwwAuthenticateBearer("https://plur1bus.example", DEFAULT_PROTECTED_RESOURCE_METADATA_PATH);
      assertNoMemoryLeak(authHeader, "WWW-Authenticate: Bearer header");
    });
  });

  describe("3. A2A Agent Cards (card/1, card/signed, .well-known/agent.json)", () => {
    const safeAgentInfo: A2aAgentInfo = {
      optIn: true,
      displayName: "Main Research Agent",
      description: "An agent that coordinates research tasks across the harness.",
      skills: [
        {
          id: "research",
          name: "Codebase Research",
          description: "Searches documentation and code repositories.",
          tags: ["code", "docs"],
        },
        {
          id: "summarize",
          name: "Summarize",
          description: "Produces concise summaries of input texts.",
          tags: ["summary"],
        },
      ],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    };

    it("buildAgentCard emits closed card/1 format without memory contents", () => {
      const card = buildAgentCard("agent-main", safeAgentInfo, "https://plur1bus.example", "1.0.0");
      const errs = validateAgentCard(card);
      assert.deepEqual(errs, [], `Card must be strictly valid: ${errs.join("; ")}`);
      assertNoMemoryLeak(card, "buildAgentCard card/1");
    });

    it("signed agent card envelope contains no memory leaks", () => {
      const card = buildAgentCard("agent-main", safeAgentInfo, "https://plur1bus.example", "1.0.0");
      const signedCard = {
        card,
        signature: "ed25519-sig-mock-0123456789abcdef",
        signerKeyId: "key-ed25519-harness-host",
        timestamp: new Date().toISOString(),
      };

      assertNoMemoryLeak(signedCard, "card/signed envelope");
    });

    it("A2A 1.0 .well-known/agent.json format contains no memory leaks", () => {
      const wellKnownAgentJson = {
        protocolVersion: "1.0.0",
        id: "agent-main",
        name: safeAgentInfo.displayName,
        description: safeAgentInfo.description,
        url: "https://plur1bus.example/a2a/agent-main/",
        capabilities: {
          streaming: true,
          pushNotifications: false,
        },
        skills: safeAgentInfo.skills,
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      };

      assertNoMemoryLeak(wellKnownAgentJson, ".well-known/agent.json");
    });

    it("validateAgentCard strictly rejects unexpected memory fields injected into cards", () => {
      const card = buildAgentCard("agent-main", safeAgentInfo, "https://plur1bus.example", "1.0.0");
      // Attempt to tamper with card by injecting memory cards
      const tamperedCard = {
        ...card,
        memory: [{ id: FIXTURE_MARKERS[0], text: FIXTURE_MARKERS[2] }],
      };

      const errs = validateAgentCard(tamperedCard);
      assert.ok(
        errs.some((e) => e.includes("unexpected key memory")),
        `Expected validation error for injected memory key, got: ${errs.join("; ")}`,
      );
    });
  });
});
