import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, defaults, tierOf, validate } from "../src/index.ts";

// Owner decision 2026-10-29: an agent's memory is recalled and captured for turns other agents cause (consult_agent,
// delegate_task); the switches live per agent and default to on.
const node = (CONFIG_SCHEMA.properties.agents as any).additionalProperties.properties.memoryExposure;

test("agents.<id>.memoryExposure has collab, mcp and a2a switches with their defaults", () => {
  const collab = node.properties.collab.properties;
  assert.deepEqual(Object.keys(collab).sort(), ["capture", "recall"]);
  assert.deepEqual(Object.keys(collab.recall.properties).sort(), ["agentPrivate", "user", "workspace"]);
  for (const leaf of [collab.capture, collab.recall.properties.workspace, collab.recall.properties.user, collab.recall.properties.agentPrivate]) {
    assert.equal(leaf.type, "boolean");
    assert.equal(leaf.default, true);
  }

  for (const ch of ["mcp", "a2a"] as const) {
    const p = node.properties[ch].properties;
    assert.deepEqual(Object.keys(p).sort(), ["capture", "recall"]);
    assert.deepEqual(Object.keys(p.recall.properties).sort(), ["agentPrivate", "user", "workspace"]);
    assert.equal(p.recall.properties.workspace.default, true);
    assert.equal(p.recall.properties.user.default, true);
    assert.equal(p.recall.properties.agentPrivate.default, true);
    assert.equal(p.capture.default, true);
  }
});

test("every node of memoryExposure is a live, advanced key that only owner and admin write, with an audit entry", () => {
  const visit = (n: any, path: string) => {
    assert.equal(n["x-restart"], "live", path);
    assert.equal(n["x-tier"], "advanced", path);
    assert.deepEqual(n["x-write-roles"], ["owner", "admin"], path);
    assert.equal(n["x-audit"], true, path);
    assert.equal(typeof n.description, "string", path);
    if (n.type === "object") { assert.equal(n.additionalProperties, false, path); for (const [k, v] of Object.entries(n.properties)) visit(v, `${path}.${k}`); }
  };
  visit(node, "memoryExposure");
});

test("tierOf resolves the nested keys to advanced", () => {
  assert.equal(tierOf("agents.bernd.memoryExposure.collab.recall.agentPrivate"), "advanced");
  assert.equal(tierOf("agents.bernd.memoryExposure.collab.capture"), "advanced");
});

test("the switches validate, unknown keys and non-booleans do not, and the installation defaults gain no agent entry", () => {
  const cfg: any = defaults();
  assert.deepEqual(cfg.agents, {});
  cfg.agents.bernd = { memoryExposure: { collab: { recall: { workspace: true, user: false, agentPrivate: false }, capture: false } } };
  assert.equal(validate(cfg).ok, true);
  for (const bad of [{ collab: { capture: "no" } }, { collab: { recall: { user: 0 } } }, { collab: { recall: { everything: true } } }, { collab: { filter: true } }, { unknownChannel: { capture: true } }]) {
    cfg.agents.bernd = { memoryExposure: bad };
    assert.equal(validate(cfg).ok, false, JSON.stringify(bad));
  }
});

test("external engine selection is owner/admin writable and audited, without an ACP memory switch", () => {
  const agent = (CONFIG_SCHEMA.properties.agents as any).additionalProperties;
  assert.deepEqual(agent.properties.engine["x-write-roles"], ["owner", "admin"]);
  assert.equal(agent.properties.engine["x-audit"], true);
  assert.equal(agent.properties.memoryExposure.properties.acp, undefined);
});
