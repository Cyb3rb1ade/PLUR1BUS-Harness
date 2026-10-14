import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults, validate } from "../src/index.ts";

describe("validate error list", () => {
  it("is bounded however many violations the input has (allErrors on attacker-sized input)", () => {
    const big: any = defaults(); big.egress.allowPorts = Array.from({ length: 50_000 }, () => "x");
    const r = validate(big);
    assert.equal(r.ok, false);
    if (!r.ok) { assert.ok(r.errors.length <= 51, `got ${r.errors.length}`); assert.ok(r.errors[0]!.includes("allowPorts")); }
  });
});
