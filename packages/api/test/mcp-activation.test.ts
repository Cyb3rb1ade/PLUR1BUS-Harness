import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MCP_TOOL_GROUPS,
  getAgentMcpGroups,
  isAgentMcpExposed,
  isMcpServerEnabled,
} from "../src/mcp/index.ts";

test("isMcpServerEnabled checks top-level flag", () => {
  assert.equal(isMcpServerEnabled(undefined), false);
  assert.equal(isMcpServerEnabled({}), false);
  assert.equal(isMcpServerEnabled({ mcpServer: { enabled: false } }), false);
  assert.equal(isMcpServerEnabled({ mcpServer: { enabled: true } }), true);
});

test("isAgentMcpExposed requires both global flag and per-agent exposure", () => {
  const configDisabled = {
    mcpServer: { enabled: false },
    agents: {
      bernd: { mcpServer: { exposed: true } },
    },
  };
  assert.equal(isAgentMcpExposed(configDisabled, "bernd"), false);

  const configEnabled = {
    mcpServer: { enabled: true },
    agents: {
      bernd: { mcpServer: { exposed: true } },
      karl: { mcpServer: { exposed: false } },
      unknown: {},
    },
  };
  assert.equal(isAgentMcpExposed(configEnabled, "bernd"), true);
  assert.equal(isAgentMcpExposed(configEnabled, "karl"), false);
  assert.equal(isAgentMcpExposed(configEnabled, "unknown"), false);
  assert.equal(isAgentMcpExposed(configEnabled, "absent"), false);
});

test("getAgentMcpGroups returns configured groups or defaults", () => {
  const config = {
    agents: {
      bernd: { mcpServer: { exposed: true, groups: ["memory", "agent"] } },
      karl: { mcpServer: { exposed: true } },
    },
  };

  assert.deepEqual(getAgentMcpGroups(config, "bernd"), ["memory", "agent"]);
  assert.deepEqual(getAgentMcpGroups(config, "karl"), DEFAULT_MCP_TOOL_GROUPS);
  assert.deepEqual(getAgentMcpGroups(config, "absent"), DEFAULT_MCP_TOOL_GROUPS);
  assert.deepEqual(getAgentMcpGroups(undefined, "bernd"), DEFAULT_MCP_TOOL_GROUPS);
});
