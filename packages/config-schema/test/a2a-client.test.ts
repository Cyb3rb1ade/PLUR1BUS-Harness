import { it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, defaults, restartClassOf, tierOf, validate } from "../src/index.ts";

it("a2aClient is an opt-in installation-wide configuration with explicit live/advanced metadata", () => {
  const config = defaults();
  assert.equal(config.a2aClient?.enabled, false);
  assert.equal(config.a2aClient?.peerCalls, 8);
  for (const [key, node] of Object.entries(CONFIG_SCHEMA.properties.a2aClient.properties) as Array<[string, Record<string, unknown>]>) {
    assert.equal(node['x-restart'], "live", key); assert.equal(node['x-tier'], "advanced", key);
    assert.deepEqual(node['x-write-roles'], ["owner"], key);
    assert.equal(restartClassOf(`a2aClient.${key}`), "live"); assert.equal(tierOf(`a2aClient.${key}`), "advanced");
  }
  assert.equal(validate({ ...config, a2aClient: { enabled: true } }).ok, true);
  assert.equal(validate({ ...config, a2aClient: { peerCalls: 0, turnTokens: 0 } }).ok, true);
  assert.equal(validate({ ...config, a2aClient: { peerCalls: -1 } }).ok, false);
  assert.equal(validate({ ...config, a2aClient: { token: "must-use-secret-store" } }).ok, false);
  assert.equal(validate({ ...config, agents: { main: { a2aClient: { enabled: true } } } }).ok, false);
});
