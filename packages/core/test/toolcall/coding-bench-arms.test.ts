/** Arm definitions are public JSON data; identities cannot be supplied independently of their parameters. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineCodingArm, parseCodingArmDefinition } from "../../src/toolcall/coding-bench-arms.ts";

test("canonical arms preserve the single control and distinguish parameterized families", () => {
  assert.deepEqual(defineCodingArm({ family: "single", params: {} }), {
    id: "single",
    family: "single",
    params: {},
  });
  const first = defineCodingArm({ family: "single", params: { review: true, effort: "highest" } });
  const reordered = defineCodingArm({ family: "single", params: { effort: "highest", review: true } });
  assert.deepEqual(first, reordered);
  assert.notEqual(first.id, defineCodingArm({ family: "single", params: { review: false, effort: "highest" } }).id);
  const explore = defineCodingArm({ family: "explore+single", params: {} });
  assert.match(explore.id, /^[a-z][a-z0-9-]{0,63}$/u);
  assert.notEqual(explore.id, defineCodingArm({ family: "explore-single", params: {} }).id);
});

test("nested key order is canonical, array order matters, and definitions retain a private data copy", () => {
  const params = { nested: { count: 2, review: true }, order: ["writer", "reviewer"] };
  const first = defineCodingArm({ family: "team", params });
  const reordered = defineCodingArm({
    family: "team",
    params: { order: ["writer", "reviewer"], nested: { review: true, count: 2 } },
  });
  assert.deepEqual(first, reordered);
  assert.notEqual(
    first.id,
    defineCodingArm({ family: "team", params: { ...params, order: ["reviewer", "writer"] } }).id,
  );
  params.nested.count = 4;
  assert.deepEqual(first.params.nested, { count: 2, review: true });
  assert.deepEqual(parseCodingArmDefinition(first), first);
});

test("arm parsing rejects forged IDs, unknown descriptor fields and malformed families", () => {
  const arm = defineCodingArm({ family: "best-of-n", params: { n: 2 } });
  assert.throws(() => parseCodingArmDefinition({ ...arm, id: "single" }));
  assert.throws(() => parseCodingArmDefinition({ ...arm, params: { n: 4 } }));
  assert.throws(() => parseCodingArmDefinition({ ...arm, endpoint: "private" }));
  assert.throws(() => parseCodingArmDefinition("single"));
  for (const family of ["", "Team", "../team", "team:two", "x".repeat(32)]) {
    assert.throws(() => defineCodingArm({ family, params: {} }));
  }
});

test("non-data parameters refuse without evaluating accessors or custom serialization", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "review", {
    enumerable: true,
    get() {
      reads++;
      return true;
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = new Array(1);
  const hidden = Object.defineProperty({}, "review", { value: true });
  const symbol = { [Symbol("review")]: true };
  const custom = {
    toJSON() {
      reads++;
      return {};
    },
  };
  for (const params of [
    accessor,
    cycle,
    hidden,
    symbol,
    custom,
    { value: sparse },
    { value: NaN },
    { value: Infinity },
    { value: undefined },
    { value: 1n },
    { value: new Date() },
    [],
  ]) {
    assert.throws(() => defineCodingArm({ family: "team", params } as never));
  }
  assert.equal(reads, 0);
});

test("parameter depth, size and node limits bound admission", () => {
  let nested: unknown = {};
  for (let index = 0; index < 40; index++) nested = { next: nested };
  for (const params of [nested, { text: "x".repeat(20_000) }, { nodes: Array.from({ length: 4097 }, () => null) }]) {
    assert.throws(() => defineCodingArm({ family: "team", params } as never));
  }
});
