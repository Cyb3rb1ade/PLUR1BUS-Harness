import { it } from "node:test";
import assert from "node:assert/strict";
import { effectRank } from "../../src/policy/effects.ts";
import { headlessGate } from "../../src/policy/headless.ts";
import { call, ctx, grant, run } from "./helpers.ts";

it("network.a2a keeps the external approval floor, taint suspension and headless refusal", () => {
  const action = call({ capability: "network.a2a", effect: "network.a2a" });
  assert.equal(effectRank("network.a2a"), effectRank("external"));
  assert.equal(run(action, ctx()).kind, "ask");
  assert.equal(run(action, ctx({ overrides: { "network.a2a": "allowed" } })).kind, "ask");
  assert.equal(run(action, ctx(), [grant("network.a2a", "session")]).kind, "allow");
  assert.equal(run(action, ctx({ taint: { tainted: true, readPrivate: true } }), [grant("network.a2a", "session")]).kind, "ask");
  assert.equal(headlessGate(run(action, ctx()), ctx({ headless: { jobId: "job" } })).kind, "deny");
});
