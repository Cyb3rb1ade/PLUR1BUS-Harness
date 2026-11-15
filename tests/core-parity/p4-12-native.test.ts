// The comparison of the P4-12 native-methods run (p4-12-native.ts); the run itself needs the built front door and is
// part of the nightly parity step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, differences, normalised, refusalLines, type Step } from "./p4-12-native.ts";

test("an answer is compared without its request id, with ids and times replaced and members in any order", () => {
  const ids = { "0198-a": "<human>" };
  const reply = { jsonrpc: "2.0", id: 7, result: { id: "0198-a", humanId: "0198-a", createdAt: 1790000000000, revokedAt: null, principals: ["user:v2:x", "0198-a"] } };
  assert.deepEqual(normalised(reply, ids), { result: { id: "<human>", humanId: "<human>", createdAt: "<time>", revokedAt: null, principals: ["user:v2:x", "<human>"] } });
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), canonical({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }));
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }), "the order of an array is part of the answer");
});

test("a step that answers differently, a missing step and a renamed one are each a difference", () => {
  const reference: Step[] = [["one", { result: { a: 1, b: 2 } }], ["two", { error: { code: -32000, message: "m", data: { error: "E_NOT_FOUND" } } }]];
  const same: Step[] = [["one", { result: { b: 2, a: 1 } }], ["two", { error: { code: -32000, data: { error: "E_NOT_FOUND" }, message: "m" } }]];
  assert.deepEqual(differences(reference, same, "leg"), []);
  assert.match(differences(reference, [same[0]!, ["two", { error: { code: -32000, data: { error: "E_DENIED" }, message: "m" } }]], "leg").join("; "), /leg, "two": expected .*E_NOT_FOUND.*, got .*E_DENIED/);
  assert.match(differences(reference, [same[0]!], "leg").join("; "), /leg: 1 steps, expected 2/);
  assert.match(differences(reference, [same[0]!, ["other", same[1]![1]]], "leg").join("; "), /leg, "two"/);
});

test("the refusal lines of an audit log are compared as written, the time aside", () => {
  const log = [
    '{"at":1790000000001,"actor":{"user":"anonymous","host":"local"},"action":"rbac.unauthenticated","target":"breakglass.notices","detail":{"action":"admin.notices.read","reason":"no-principal"}}',
    '{"at":1790000000002,"actor":{"user":"core","host":"core"},"action":"identity.human.create","target":"x","detail":{}}',
    '{"at":1790000000003,"actor":{"user":"local-owner","host":"local"},"action":"rbac.denied","target":"user.role.set","detail":{"action":"admin.users.write","reason":"role-denied","role":"viewer"}}',
    "",
  ].join("\n");
  assert.deepEqual(refusalLines(log), [
    '{"at":"<time>","actor":{"user":"anonymous","host":"local"},"action":"rbac.unauthenticated","target":"breakglass.notices","detail":{"action":"admin.notices.read","reason":"no-principal"}}',
    '{"at":"<time>","actor":{"user":"local-owner","host":"local"},"action":"rbac.denied","target":"user.role.set","detail":{"action":"admin.users.write","reason":"role-denied","role":"viewer"}}',
  ]);
  // Member order is part of a line: a writer that orders them differently is a difference.
  assert.notEqual(refusalLines('{"at":1,"action":"rbac.denied","actor":{}}\n')[0], refusalLines('{"at":1,"actor":{},"action":"rbac.denied"}\n')[0]);
  assert.deepEqual(refusalLines(""), []);
});
