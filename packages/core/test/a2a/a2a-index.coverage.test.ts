import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as barrel from "../../src/a2a/index.ts";
import * as handler from "../../src/a2a/handler.ts";
import * as server from "../../src/a2a/server.ts";
import * as card from "../../src/a2a/card.ts";
import * as policy from "../../src/a2a/policy.ts";
import * as tasks from "../../src/a2a/tasks.ts";
import * as parts from "../../src/a2a/parts.ts";
import * as push from "../../src/a2a/push.ts";
import * as turnPort from "../../src/a2a/turn-port.ts";
import * as events from "../../src/a2a/events.ts";
import * as types from "../../src/a2a/types.ts";

const reexports: [string, Record<string, unknown>, string[]][] = [
  ["handler.ts", handler, ["createA2aHandler", "BodyTooLarge"]],
  ["server.ts", server, ["createA2aServer", "loopbackAddress"]],
  ["card.ts", card, ["buildAgentCard", "validateAgentCard", "DEFAULT_CARD_FEATURES"]],
  ["policy.ts", policy, ["authorizePeer", "hashKey", "resolvePeer", "validatePeers"]],
  ["tasks.ts", tasks, ["TaskStore", "TaskError", "realScheduler"]],
  ["parts.ts", parts, ["parseParts", "PartError"]],
  ["push.ts", push, ["parsePushConfig", "createEgressPushTransport", "PushDispatcher", "PushError", "assignPushId", "toTaskPush"]],
  ["turn-port.ts", turnPort, ["createProviderTurnPort", "createSessionTurnPort", "openA2aSessionBackend", "a2aCaller"]],
  ["events.ts", events, ["statusUpdate", "artifactUpdate", "sseLines"]],
];

describe("a2a barrel", () => {
  for (const [file, mod, names] of reexports) {
    for (const name of names) {
      it(`re-exports ${name} from ${file} by identity`, () => {
        assert.ok(name in barrel, `${name} missing from barrel`);
        assert.equal((barrel as Record<string, unknown>)[name], mod[name]);
        assert.notEqual(mod[name], undefined);
      });
    }
  }
  it("re-exports every runtime value of types.ts", () => {
    const names = Object.keys(types);
    assert.ok(names.length >= 6);
    for (const n of ["A2A_PROTOCOL_VERSION", "A2A_ACTIONS", "TASK_STATES", "TERMINAL_STATES", "CANCELABLE_STATES", "RESUMABLE_STATES", "DEFAULT_LIMITS", "RPC"]) assert.ok(names.includes(n), n);
    for (const n of names) assert.equal((barrel as Record<string, unknown>)[n], (types as Record<string, unknown>)[n], n);
  });
  it("exposes exactly the documented runtime surface (no accidental leaks such as Buckets or validAgentId)", () => {
    const expected = new Set([...reexports.flatMap(([, , n]) => n), ...Object.keys(types)]);
    assert.deepEqual(new Set(Object.keys(barrel)), expected);
    for (const hidden of ["Buckets", "validAgentId", "createProviderTurnPortInternal"]) assert.ok(!(hidden in barrel), hidden);
  });
  it("the re-exported pieces work together through the barrel", () => {
    const c = barrel.buildAgentCard("bernd", { optIn: true }, "http://127.0.0.1:1", "0.0.1");
    assert.deepEqual(barrel.validateAgentCard(c), []);
    assert.equal(barrel.A2A_PROTOCOL_VERSION, c.protocolVersion);
    assert.equal(barrel.hashKey("k").length, 64);
    assert.equal(barrel.loopbackAddress("localhost"), "127.0.0.1");
    assert.equal(barrel.toTaskPush("t", { url: "http://x/" }).taskId, "t");
    assert.equal(barrel.a2aCaller("p").userId, "p");
    assert.equal(new barrel.BodyTooLarge().name, "BodyTooLarge");
    assert.equal(barrel.RPC.parse, -32700);
  });
});
