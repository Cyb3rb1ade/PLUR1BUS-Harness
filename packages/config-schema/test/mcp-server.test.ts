/** MCP server configuration stays typed, disabled by default, and live per agent (M6-A). */
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

describe("MCP server configuration", () => {
  it("defaults top-level mcpServer to disabled", () => {
    assert.deepEqual(defaults().mcpServer, { enabled: false });
  });

  it("accepts enabled boolean flag", () => {
    const validTrue = validate({ ...defaults(), mcpServer: { enabled: true } });
    assert.equal(validTrue.ok, true);
    if (validTrue.ok) {
      assert.equal(validTrue.config.mcpServer.enabled, true);
    }

    const validFalse = validate({ ...defaults(), mcpServer: { enabled: false } });
    assert.equal(validFalse.ok, true);
    if (validFalse.ok) {
      assert.equal(validFalse.config.mcpServer.enabled, false);
    }
  });

  it("rejects non-boolean enabled and unknown properties on mcpServer", () => {
    assert.equal(validate({ ...defaults(), mcpServer: { enabled: "true" as any } }).ok, false);
    assert.equal(validate({ ...defaults(), mcpServer: { enabled: 1 as any } }).ok, false);
    assert.equal(validate({ ...defaults(), mcpServer: { enabled: true, extra: "disallowed" } as any }).ok, false);
  });

  it("mcpServer change is live and advanced tier", () => {
    const before = defaults();
    const after = { ...defaults(), mcpServer: { enabled: true } };
    const plan = restartPlan(before, after);
    assert.deepEqual(plan.restart, {
      live: ["mcpServer.enabled"],
      core: false,
      modules: [],
    });

    assert.equal(restartClassOf("mcpServer"), "live");
    assert.equal(restartClassOf("mcpServer.enabled"), "live");
    assert.equal(tierOf("mcpServer"), "advanced");
    assert.equal(tierOf("mcpServer.enabled"), "advanced");

    assert.equal(Object.hasOwn(filterConfigByTier(after, "basic"), "mcpServer"), false);
    assert.deepEqual(filterConfigByTier(after, "advanced").mcpServer, after.mcpServer);
  });

  it("accepts valid per-agent mcpServer configuration", () => {
    const config = {
      ...defaults(),
      agents: {
        bernd: {
          mcpServer: {
            exposed: true,
            groups: ["memory", "agent"],
          },
        },
      },
    };
    const res = validate(config);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.config.agents.bernd.mcpServer, {
        exposed: true,
        groups: ["memory", "agent"],
      });
    }
  });

  it("defaults per-agent mcpServer to unexposed with standard groups", () => {
    const config = {
      ...defaults(),
      agents: {
        bernd: {
          mcpServer: {},
        },
      },
    };
    const res = validate(config);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.config.agents.bernd.mcpServer, {
        exposed: false,
        groups: ["memory", "agent", "skills"],
      });
    }
  });

  it("rejects invalid per-agent mcpServer properties", () => {
    // Non-boolean exposed
    assert.equal(
      validate({
        ...defaults(),
        agents: { bernd: { mcpServer: { exposed: "yes" as any } } },
      }).ok,
      false,
    );

    // Invalid group names
    assert.equal(
      validate({
        ...defaults(),
        agents: { bernd: { mcpServer: { groups: ["Invalid Group!"] } } },
      }).ok,
      false,
    );

    // Duplicate groups
    assert.equal(
      validate({
        ...defaults(),
        agents: { bernd: { mcpServer: { groups: ["memory", "memory"] } } },
      }).ok,
      false,
    );

    // Unknown field
    assert.equal(
      validate({
        ...defaults(),
        agents: { bernd: { mcpServer: { unknownField: true } as any } },
      }).ok,
      false,
    );
  });

  it("per-agent mcpServer is live and advanced tier", () => {
    assert.equal(restartClassOf("agents.bernd.mcpServer"), "live");
    assert.equal(restartClassOf("agents.bernd.mcpServer.exposed"), "live");
    assert.equal(restartClassOf("agents.bernd.mcpServer.groups"), "live");

    assert.equal(tierOf("agents.bernd.mcpServer"), "advanced");
    assert.equal(tierOf("agents.bernd.mcpServer.exposed"), "advanced");
    assert.equal(tierOf("agents.bernd.mcpServer.groups"), "advanced");
  });
});
