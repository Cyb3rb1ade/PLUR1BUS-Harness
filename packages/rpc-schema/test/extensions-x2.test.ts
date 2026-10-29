/** X2 extends extension RPC kinds while preserving existing method contracts. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilities, validateNotification, validateParams, validateResult } from "../src/index.ts";

describe("X2 extension RPC kinds", () => {
  it("accepts MCP servers and bundles throughout extension results and notifications", () => {
    for (const kind of ["skill", "module", "channel", "mcp-server", "bundle"]) {
      assert.deepEqual(validateParams("ext.list", { kind: [kind] }), { ok: true }, kind);
      assert.deepEqual(validateResult("ext.install", {
        name: "docs", version: "1.0.0", kind, replaced: false, state: "installed",
      }), { ok: true }, kind);
      assert.deepEqual(validateNotification("ext.changed", {
        name: "docs", version: "1.0.0", kind, state: "installed", overlays: [],
      }), { ok: true }, kind);
    }
  });

  it("keeps provider and unknown kinds outside the RPC lifecycle", () => {
    for (const kind of ["provider", "unknown"]) {
      assert.equal(validateParams("ext.list", { kind: [kind] }).ok, false, kind);
      assert.equal(validateResult("ext.install", {
        name: "docs", version: "1.0.0", kind, replaced: false, state: "installed",
      }).ok, false, kind);
    }
  });

  it("preserves explicit install activation and the original method introduction version", () => {
    assert.deepEqual(validateParams("ext.install", {
      inspectionId: "inspection", enable: { agents: ["agent-a"] }, acknowledge: ["capabilities"],
    }), { ok: true });
    assert.equal(validateParams("ext.install", { inspectionId: "inspection", unexpected: true }).ok, false);
    assert.deepEqual(buildCapabilities([], "supervisor").methods["ext.install"], {
      stability: "experimental", since: "1.4.0",
    });
  });
});
