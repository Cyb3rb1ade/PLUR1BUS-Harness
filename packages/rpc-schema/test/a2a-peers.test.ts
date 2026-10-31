import { it } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilities, loadFixtures, validateParams, validateResult } from "../src/index.ts";

it("outbound peer RPC has closed inputs and additive experimental 1.12 contracts", () => {
  const fixtures = loadFixtures().methods;
  for (const name of ["a2a.peer.add", "a2a.peer.list", "a2a.peer.remove", "a2a.peer.trust"]) {
    assert.deepEqual(buildCapabilities([], "core").methods[name], { stability: "experimental", since: "1.12.0" });
    const example = fixtures[name]!;
    assert.equal(validateParams(name, example.params).ok, true);
    assert.equal(validateResult(name, example.result).ok, true);
    assert.equal(validateParams(name, { ...example.params as object, trust: true }).ok, false);
  }
  const add = fixtures['a2a.peer.add']!.params as Record<string, unknown>;
  assert.equal(validateParams('a2a.peer.add', { ...add, publicKey: { ...add.publicKey as object, d: "PRIVATE-MATERIAL" } }).ok, false);
  assert.equal(validateParams('a2a.peer.trust', { id: "peer", fingerprint: 'sha256:' + 'A'.repeat(43) }).ok, false);
  assert.equal(validateParams('project.agent.add', { projectId: "p", agentId: "a2a:peer" }).ok, true);
  assert.equal(validateParams('agent.open', { agentId: "a2a:peer" }).ok, false, 'foreign targets are not local agent ids');
});
