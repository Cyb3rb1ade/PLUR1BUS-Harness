// The comparison of the P4-12 native-methods run (p4-12-native.ts); the run itself needs the built front door and is
// part of the nightly parity step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditLines, canonical, differences, normalised, type Step } from "./p4-12-native.ts";

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
  assert.deepEqual(auditLines(log), [
    '{"at":"<time>","actor":{"user":"anonymous","host":"local"},"action":"rbac.unauthenticated","target":"breakglass.notices","detail":{"action":"admin.notices.read","reason":"no-principal"}}',
    '{"at":"<time>","actor":{"user":"local-owner","host":"local"},"action":"rbac.denied","target":"user.role.set","detail":{"action":"admin.users.write","reason":"role-denied","role":"viewer"}}',
  ]);
  // Member order is part of a line: a writer that orders them differently is a difference.
  assert.notEqual(auditLines('{"at":1,"action":"rbac.denied","actor":{}}\n')[0], auditLines('{"at":1,"actor":{},"action":"rbac.denied"}\n')[0]);
  assert.deepEqual(auditLines(""), []);
});

test("the audit lines of a change are compared too, with the ids of the run named wherever they stand", () => {
  const human = "0198c2a0-0000-7000-8000-000000000001", hash = "ab".repeat(32);
  const log = [
    `{"at":1790000000001,"actor":{"user":"local-owner","host":"rpc"},"action":"user.role.set","target":"${human}","detail":{"previous":"member","role":"operator"}}`,
    `{"at":1790000000002,"actor":{"user":"f815","host":"rpc"},"action":"user.disabled","target":"${hash}","detail":{"role":"operator","reason":"left"}}`,
    `{"at":1790000000003,"actor":{"user":"f815","host":"rpc"},"action":"user.enabled","target":"${hash}","detail":{"role":"operator"}}`,
    '{"at":1790000000004,"actor":{"user":"local-owner","host":"rpc"},"action":"user.invite.create","target":"invitation","detail":{}}',
    "",
  ].join("\n");
  assert.deepEqual(auditLines(log, { [human]: "<human>", [hash]: "<hash of the human>" }), [
    '{"at":"<time>","actor":{"user":"local-owner","host":"rpc"},"action":"user.role.set","target":"<human>","detail":{"previous":"member","role":"operator"}}',
    '{"at":"<time>","actor":{"user":"f815","host":"rpc"},"action":"user.disabled","target":"<hash of the human>","detail":{"role":"operator","reason":"left"}}',
    '{"at":"<time>","actor":{"user":"f815","host":"rpc"},"action":"user.enabled","target":"<hash of the human>","detail":{"role":"operator"}}',
  ]);
  // Only a whole JSON string is an id: a text that merely contains one stays as written.
  assert.deepEqual(auditLines(`{"at":1,"action":"user.role.set","target":"x${human}"}\n`, { [human]: "<human>" }), [`{"at":"<time>","action":"user.role.set","target":"x${human}"}`]);
});
