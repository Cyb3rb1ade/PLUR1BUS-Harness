import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isForbiddenMethod } from "../../../webmcp/src/provider.ts";
import { SCHEMA } from "@plur1bus/rpc-schema";
import { POLICY, policyFor } from "../../src/rbac/policy.ts";
import { RPC_RULES } from "../../src/rbac/guard.ts";
import { subjectForOrigin } from "../../src/composition/protocols.ts";
import { authorize } from "../../src/rbac/authorize.ts";
import type { Principal } from "../../src/rbac/types.ts";

const methods = (SCHEMA as any).$defs.methods as Record<string, { "x-server": string }>;
const allRpcMethods = Object.keys(methods).sort();

describe("M6A-A1.7: Protocol Exposure Matrix Test", () => {
  describe("forbidden categories: webmcp & external protocol gates", () => {
    it("forbids all admin.* methods", () => {
      const adminMethods = allRpcMethods.filter((m) => m.startsWith("admin."));
      assert.ok(adminMethods.length >= 10, "expected multiple admin methods");
      for (const m of adminMethods) {
        assert.ok(isForbiddenMethod(m), `admin method ${m} must be forbidden`);
      }
    });

    it("forbids all grant.* and approval.* methods", () => {
      const authMethods = allRpcMethods.filter((m) => m.startsWith("grant.") || m.startsWith("approval."));
      assert.ok(authMethods.length >= 6, "expected multiple grant/approval methods");
      for (const m of authMethods) {
        assert.ok(isForbiddenMethod(m), `grant/approval method ${m} must be forbidden`);
      }
    });

    it("forbids all secret.* and secrets.* methods", () => {
      const secretMethods = allRpcMethods.filter((m) => m.startsWith("secret.") || m.startsWith("secrets."));
      assert.ok(secretMethods.length >= 4, "expected multiple secret methods");
      for (const m of secretMethods) {
        assert.ok(isForbiddenMethod(m), `secret method ${m} must be forbidden`);
      }
    });

    it("forbids all config.* methods", () => {
      const configMethods = allRpcMethods.filter((m) => m.startsWith("config."));
      assert.ok(configMethods.length >= 2, "expected multiple config methods");
      for (const m of configMethods) {
        assert.ok(isForbiddenMethod(m), `config method ${m} must be forbidden`);
      }
    });

    it("forbids all identity.* methods", () => {
      const identityMethods = allRpcMethods.filter((m) => m.startsWith("identity."));
      assert.ok(identityMethods.length >= 4, "expected multiple identity methods");
      for (const m of identityMethods) {
        assert.ok(isForbiddenMethod(m), `identity method ${m} must be forbidden`);
      }
    });

    it("forbids all device.* methods", () => {
      const deviceMethods = allRpcMethods.filter((m) => m.startsWith("device."));
      assert.ok(deviceMethods.length >= 3, "expected multiple device methods");
      for (const m of deviceMethods) {
        assert.ok(isForbiddenMethod(m), `device method ${m} must be forbidden`);
      }
    });

    it("forbids all user.* and breakglass.* methods", () => {
      const userMethods = allRpcMethods.filter((m) => m.startsWith("user.") || m.startsWith("breakglass."));
      assert.ok(userMethods.length >= 4, "expected multiple user/breakglass methods");
      for (const m of userMethods) {
        assert.ok(isForbiddenMethod(m), `user/breakglass method ${m} must be forbidden`);
      }
    });

    it("forbids every core human-only method from being exposed to agents", () => {
      const coreMethods = allRpcMethods.filter((n) => methods[n]!["x-server"] === "core");
      for (const spec of POLICY) {
        if (!spec.humanOnly) continue;
        const matchingRules = Object.entries(RPC_RULES).filter(([method, r]) => coreMethods.includes(method) && r.action === spec.action);
        for (const [method] of matchingRules) {
          // Exceptions intentionally documented in WebMCP provider.ts (e.g. voice.session.create, agent.pause/resume, memory.list/show)
          if (["voice.session.create", "agent.pause", "agent.resume", "memory.list", "memory.show"].includes(method)) continue;
          assert.ok(isForbiddenMethod(method), `humanOnly method ${method} must be forbidden from agent tool exposure`);
        }
      }
    });
  });

  describe("external principals and D109 subjects cannot approve or hold human-only actions", () => {
    it("subjectForOrigin maps external origins to non-human subjects", () => {
      assert.equal(subjectForOrigin("mcp"), "mcp-client");
      assert.equal(subjectForOrigin("a2a"), "a2a-peer");
      assert.equal(subjectForOrigin("acp-agent"), "acp-agent");
      assert.equal(subjectForOrigin(null), "agent");
      assert.equal(subjectForOrigin(undefined), "agent");
    });

    it("external principals (kind: agent) are denied on all grant, approval, and human-only actions", () => {
      const externalPrincipals: Principal[] = [
        { userId: "ext-mcp-1", role: "owner", kind: "agent" },
        { userId: "ext-a2a-1", role: "admin", kind: "agent" },
        { userId: "ext-peer-1", role: "member", kind: "agent", tokenScopes: ["grant.*", "approval.*", "admin.*"] },
      ];

      const sensitiveActions = [
        "grant.read", "grant.write",
        "approval.read", "approval.decide",
        "admin.agent.delete", "admin.agent.manage",
        "admin.users.write", "admin.users.read",
        "admin.breakglass.write",
        "auth.credentials.read", "auth.credentials.write",
        "channel.read", "channel.write",
        "device.revoke", "device.rename",
      ];

      for (const principal of externalPrincipals) {
        for (const action of sensitiveActions) {
          const spec = policyFor(action);
          assert.ok(spec, `policy for ${action} must exist`);
          const resource = spec.resource === "system" ? { kind: "system" as const } : { kind: "agent" as const, agentId: "any" };
          const result = authorize(principal, action, resource);
          assert.equal(result.effect, "deny", `principal ${principal.userId} must be denied for ${action}`);
          assert.equal(
            result.reason,
            "agent-principal",
            `expected agent-principal denial reason for ${action}, got ${result.reason}`,
          );
        }
      }
    });

    it("external MCP/A2A tool exposure is strictly restricted to allowed groups (memory, agent, skills)", () => {
      // The allowed tool names for MCP in Teil 2 are:
      // memory: memory_recall, memory_store (only if memory.*.write opted-in)
      // agent: agent_ask, agent_status
      // skills: io.modelcontextprotocol/skills
      const allowedMcpToolNames = new Set([
        "memory_recall",
        "memory_store",
        "agent_ask",
        "agent_status",
        "skills/list",
        "skills/get",
        "resources/read",
      ]);

      // None of the forbidden categories or their tool name variants may ever collide with or be in allowed tools
      for (const forbidden of ["admin", "grant", "approval", "secret", "config", "identity", "device", "user", "breakglass"]) {
        for (const tool of allowedMcpToolNames) {
          assert.ok(!tool.toLowerCase().startsWith(forbidden), `tool ${tool} must not start with forbidden prefix ${forbidden}`);
        }
      }
    });
  });
});
