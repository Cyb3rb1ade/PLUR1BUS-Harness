/** MCP extension activation stays typed, disabled by default, and live per agent. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  filterConfigByTier,
  restartClassOf,
  restartPlan,
  tierOf,
  validate,
} from "../src/index.ts";

function configWith(servers: unknown): unknown {
  return { ...defaults(), mcp: { servers } };
}

describe("MCP extension configuration", () => {
  it("defaults new servers to disabled and all agents", () => {
    const result = validate(configWith({ docs: {} }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.config.mcp, { servers: { docs: { enabled: false, agents: "all" } } });
    assert.deepEqual(defaults().mcp, { servers: {} });
  });

  it("accepts all agents, explicit valid agents and an empty selection", () => {
    for (const agents of ["all", [], ["agent-a", "agent_b", "0", "a".repeat(64)]]) {
      assert.equal(validate(configWith({ docs: { enabled: true, agents } })).ok, true, JSON.stringify(agents));
    }
  });

  it("rejects invalid agents and repeated selections", () => {
    for (const agents of ["agent-a", ["agent-a", "agent-a"], [""], ["Agent"], ["a.b"], ["a".repeat(65)], [1]]) {
      assert.equal(validate(configWith({ docs: { agents } })).ok, false, JSON.stringify(agents));
    }
  });

  it("bounds explicit selections to 256 agents", () => {
    const agents = Array.from({ length: 256 }, (_, index) => `agent-${index}`);
    assert.equal(validate(configWith({ docs: { agents } })).ok, true);
    assert.equal(validate(configWith({ docs: { agents: [...agents, "agent-256"] } })).ok, false);
  });

  it("rejects unknown properties, invalid names and wrong activation types", () => {
    for (const servers of [{ docs: { enabled: "yes" } }, { docs: { command: "node" } },
      { "../docs": {} }, { "Docs": {} }, { ["a".repeat(63)]: {} }, []]) {
      assert.equal(validate(configWith(servers)).ok, false, JSON.stringify(servers));
    }
    assert.equal(validate({ ...defaults(), mcp: { servers: {}, unknown: true } }).ok, false);
  });

  it("changes activation and agent selection live without restarting processes", () => {
    const before = validate(configWith({ docs: { enabled: false, agents: "all" } }));
    const after = validate(configWith({ docs: { enabled: true, agents: ["agent-a"] } }));
    assert.ok(before.ok && after.ok);
    const plan = restartPlan(before.config, after.config);
    assert.deepEqual(plan.restart, {
      live: ["mcp.servers.docs.agents", "mcp.servers.docs.enabled"], core: false, modules: [],
    });
    for (const path of ["mcp", "mcp.servers", "mcp.servers.docs", "mcp.servers.docs.enabled", "mcp.servers.docs.agents"]) {
      assert.equal(restartClassOf(path), "live", path);
      assert.equal(tierOf(path), "advanced", path);
    }
    assert.equal(Object.hasOwn(filterConfigByTier(after.config, "basic"), "mcp"), false);
    assert.deepEqual(filterConfigByTier(after.config, "advanced").mcp, after.config.mcp);
  });
});
