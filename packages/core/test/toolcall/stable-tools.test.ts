// Stable-offer regressions: core priority, bounded session retention and current-permission revocation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stableToolOffer } from "../../src/toolcall/stable-tools.ts";

test("the stable core wins over relevant tools and the returned set has deterministic bytes", () => {
  const input = {
    available: ["exec.run", "file.read", "web.search", "skill.load", "capabilities.search", "file.list"],
    relevant: ["exec.run"],
    maxTools: 5,
  };
  assert.deepEqual(stableToolOffer(input), {
    names: ["capabilities.search", "file.list", "file.read", "skill.load", "web.search"],
    dropped: ["exec.run"],
    coreOverflow: false,
  });
  assert.deepEqual(stableToolOffer({ ...input, available: [...input.available].reverse() }), stableToolOffer(input));
});

test("prior offers stay available before new relevance and revoked tools disappear at a turn boundary", () => {
  const first = stableToolOffer({
    available: ["file.read", "file.list", "exec.run", "document.render"],
    relevant: ["exec.run"],
    maxTools: 4,
  });
  const second = stableToolOffer({
    available: ["file.read", "file.list", "exec.run", "document.render"],
    previous: first.names,
    relevant: ["document.render"],
    maxTools: 4,
  });
  assert.deepEqual(second.names, ["document.render", "exec.run", "file.list", "file.read"]);
  const full = stableToolOffer({
    available: ["file.read", "file.list", "exec.run", "document.render", "image.generate"],
    previous: second.names,
    relevant: ["image.generate"],
    maxTools: 4,
  });
  assert.deepEqual(full.names, second.names);
  const revoked = stableToolOffer({
    available: ["file.read", "file.list", "document.render", "image.generate"],
    previous: full.names,
    relevant: ["image.generate"],
    maxTools: 4,
  });
  assert.deepEqual(revoked.names, ["document.render", "file.list", "file.read", "image.generate"]);
});

test("memory tools are core and low family caps are enforced with explicit overflow evidence", () => {
  const result = stableToolOffer({
    available: [
      "memory.recall", "memory.capture", "memory.search", "file.read", "file.list", "web.fetch", "web.search",
      "skill.load", "skill.read", "capabilities.search",
    ],
    relevant: ["exec.run"],
    maxTools: 4,
  });
  assert.equal(result.names.length, 4);
  assert.equal(result.coreOverflow, true);
  assert.equal(result.dropped.length, 6);
  const memory = stableToolOffer({
    available: ["exec.run", "memory.search"], relevant: ["exec.run"], maxTools: 1,
  });
  assert.deepEqual(memory.names, ["memory.search"]);
});

test("empty and invalid caps never bypass the family tool limit", () => {
  assert.deepEqual(stableToolOffer({ available: ["file.read"], maxTools: 0 }), {
    names: [], dropped: ["file.read"], coreOverflow: true,
  });
  for (const maxTools of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => stableToolOffer({ available: ["file.read"], maxTools }));
  }
});
