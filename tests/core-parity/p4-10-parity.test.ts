import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { beyondFloor, diffPath, G1_EXPECTED, withoutExpected } from "./p4-10-parity.ts";

describe("the noise floor of P4-10's comparison", () => {
  it("names where a difference is, without its values", () => {
    assert.equal(diffPath('conn 0, response to #3 memory.recall: $.result.blocks[2].text: expected "a", got "b"'), "conn 0, response to #3 memory.recall: $.result.blocks[2].text");
    assert.equal(diffPath("conn 1, response to #2 x.y: $.result.z: missing, expected 1"), "conn 1, response to #2 x.y: $.result.z");
    assert.equal(diffPath('conn 0, notification a.b: $.params.q: unexpected, got "x\ny"'), "conn 0, notification a.b: $.params.q");
  });

  it("keeps only the front door's differences at a place where two stock cores agree", () => {
    const control = ['conn 0, response to #3 memory.recall: $.result.text: expected "a", got "b"'];
    const frontDoor = ['conn 0, response to #3 memory.recall: $.result.text: expected "c", got "d"', "conn 0, response to #4 core.status: $.result.process: expected 1, got 2"];
    assert.deepEqual(beyondFloor(frontDoor, control), ["conn 0, response to #4 core.status: $.result.process: expected 1, got 2"]);
    assert.deepEqual(beyondFloor([], control), []);
  });

  it("sets aside only the methods G1 expects to differ, each with its reason", () => {
    assert.ok(G1_EXPECTED["bridge.hello"]?.includes("bridge"));
    const diffs = ["conn 0, response to #bridge.hello#93 bridge.hello: $.error.code: expected -32601, got -32000", "conn 0, response to #core.status#94 core.status: $.result.rpc: expected 1, got 2"];
    assert.deepEqual(withoutExpected(diffs), ["conn 0, response to #core.status#94 core.status: $.result.rpc: expected 1, got 2"]);
  });
});
