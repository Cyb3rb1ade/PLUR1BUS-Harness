import { test } from "node:test";
import assert from "node:assert/strict";
import { configActor } from "../../src/rbac/config-actor.ts";
import { ROLES } from "../../src/rbac/types.ts";

// P4D-39: the supervisor takes the core for the local owner, so the core names the person a write is made for.
test("a person is named with their role; anything else is named as a viewer", () => {
  for (const role of ROLES) {
    assert.deepEqual(configActor({ userId: "usr_a", role, kind: "person" }), { kind: "person", userId: "usr_a", role });
    // An agent acting with somebody's role, and a principal no resolver stated the kind of, never carry that role.
    assert.deepEqual(configActor({ userId: "agt_a", role, kind: "agent" }), { kind: "person", userId: "agt_a", role: "viewer" });
    assert.deepEqual(configActor({ userId: "usr_b", role }), { kind: "person", userId: "usr_b", role: "viewer" });
  }
});
