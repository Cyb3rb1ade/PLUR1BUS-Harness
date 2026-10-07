import assert from "node:assert/strict";
import test from "node:test";
import { ARGON2_PARAMS, hashPassword, needsRehash, parsePhc, verifyPassword } from "../src/password.ts";

// Fixture passwords are made up here; none is a real credential.
const PW = "correct horse battery staple (fixture)";

test("hashPassword yields a PHC argon2id string with the documented parameters and a fresh salt per call", async () => {
  const a = await hashPassword(PW); const b = await hashPassword(PW);
  assert.match(a, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.notEqual(a, b);
  assert.deepEqual({ m: ARGON2_PARAMS.memoryKiB, t: ARGON2_PARAMS.passes, p: ARGON2_PARAMS.parallelism }, { m: 19456, t: 2, p: 1 });
  assert.equal(a.includes(PW), false);
});

test("verifyPassword accepts the right password and refuses a wrong, empty or oversized one", async () => {
  const h = await hashPassword(PW);
  assert.equal(await verifyPassword(h, PW), true);
  assert.equal(await verifyPassword(h, PW + "x"), false);
  assert.equal(await verifyPassword(h, ""), false);
  assert.equal(await verifyPassword(h, "a".repeat(2000)), false);
  assert.equal(await verifyPassword(h, 5 as unknown as string), false);
});

test("a malformed or hostile stored hash is false, never an exception or an allocation bomb", async () => {
  for (const bad of ["", "plain", "$argon2i$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43), "$argon2id$v=19$m=99999999,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43), "$argon2id$v=19$m=19456,t=9999,p=1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43), "$argon2id$v=19$m=19456,t=2,p=1$short$" + "A".repeat(43), undefined as unknown as string]) {
    assert.equal(await verifyPassword(bad, PW), false, String(bad).slice(0, 30));
  }
  assert.equal(parsePhc("$argon2id$v=19$m=8,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43)), undefined, "below the floor is not trusted either");
});

test("needsRehash is true when the stored parameters differ from the current ones (and for unparseable hashes), false otherwise", async () => {
  const h = await hashPassword(PW);
  assert.equal(needsRehash(h), false);
  assert.equal(needsRehash(h.replace("m=19456", "m=12288")), true);
  assert.equal(needsRehash(h.replace("t=2", "t=1")), true);
  assert.equal(needsRehash("garbage"), true);
  assert.equal(needsRehash(h, { ...ARGON2_PARAMS, passes: 3 }), true);
});
