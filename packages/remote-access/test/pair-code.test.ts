import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_ALPHABET, PairCodeStore, deriveKey, formatCode, generateCode, normalizeCode } from "../src/pair-code.ts";

// Light Argon2id parameters keep the suite fast; the cost is a constructor option, the defaults are asserted separately.
const LIGHT = { memoryKiB: 64, passes: 1, parallelism: 1 } as const;
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const store = (over: Partial<ConstructorParameters<typeof PairCodeStore>[0]> = {}) => new PairCodeStore({ params: LIGHT, ...over });

test("codes: XXXX-XXXX from an unambiguous 32-character alphabet", () => {
  assert.equal(CODE_ALPHABET.length, 32);
  assert.ok(!/[IO01]/.test(CODE_ALPHABET));
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const c = generateCode();
    assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 495, "no visible collisions in 500 draws of a 40-bit space");
});

test("normalizeCode: forgiving about case, spaces and the hyphen, strict about everything else", () => {
  assert.equal(normalizeCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizeCode(" ABCD EFGH "), "ABCDEFGH");
  assert.equal(normalizeCode("ABCD--EFGH "), "ABCDEFGH", "stray separators are ignored, not an error");
  assert.equal(normalizeCode("ABCDEFGH"), "ABCDEFGH");
  assert.equal(formatCode("ABCDEFGH"), "ABCD-EFGH");
  for (const bad of ["", "ABCD-EFG", "ABCD-EFGHJ", "ABCD-EFG0", "ABCD-EFGO", "ABCD-EFGI", "ABCD-EFG1", "ÄBCD-EFGH"]) {
    assert.equal(normalizeCode(bad), undefined, bad);
  }
});

test("deriveKey: Argon2id over the code, 32 bytes, depends on code and salt", () => {
  const salt = Buffer.alloc(16, 1);
  const k = deriveKey("ABCDEFGH", salt, LIGHT);
  assert.equal(k.length, 32);
  assert.deepEqual(deriveKey("ABCDEFGH", salt, LIGHT), k);
  assert.notDeepEqual(deriveKey("ABCDEFGJ", salt, LIGHT), k);
  assert.notDeepEqual(deriveKey("ABCDEFGH", Buffer.alloc(16, 2), LIGHT), k);
  assert.notDeepEqual(deriveKey("ABCDEFGH", salt, { ...LIGHT, passes: 2 }), k);
});

test("issue/redeem: the code is single-use and expires after one hour", () => {
  const s = store();
  const a = s.issue(T0);
  assert.equal(a.expiresAt, T0 + HOUR);
  assert.equal(s.redeem(a.code.toLowerCase().replace("-", " "), T0 + 1000).ok, true);
  assert.deepEqual(s.redeem(a.code, T0 + 2000), { ok: false, reason: "invalid" }, "second use");
  const b = s.issue(T0);
  assert.deepEqual(s.redeem(b.code, T0 + HOUR), { ok: false, reason: "invalid" }, "at the expiry instant");
  const c = s.issue(T0);
  assert.equal(s.redeem(c.code, T0 + HOUR - 1).ok, true);
  assert.deepEqual(s.redeem("not a code", T0), { ok: false, reason: "invalid" });
});

test("the store keeps a hash of a derived key, never the code", () => {
  const s = store();
  const { code, id } = s.issue(T0);
  const dump = JSON.stringify(s.snapshot(T0));
  assert.ok(!dump.includes(code));
  assert.ok(!dump.includes(code.replace("-", "")));
  assert.ok(dump.includes(id));
  const entry = s.snapshot(T0)[0]!;
  assert.deepEqual(Object.keys(entry).sort(), ["expiresAt", "failures", "id", "salt", "used", "verifier"]);
  assert.equal(entry.used, false);
  s.redeem(code, T0);
  assert.equal(s.snapshot(T0).find((e) => e.id === id)?.used, true);
});

test("at most three codes are pending; used and expired ones free their slot", () => {
  const s = store();
  const first = s.issue(T0);
  s.issue(T0);
  s.issue(T0);
  assert.throws(() => s.issue(T0), /pending/i);
  s.redeem(first.code, T0);
  assert.ok(s.issue(T0), "a used code frees its slot");
  assert.throws(() => s.issue(T0), /pending/i);
  assert.ok(s.issue(T0 + HOUR + 1), "everything expired: slots are free again");
});

test("revoke makes an open code unusable", () => {
  const s = store();
  const a = s.issue(T0);
  s.revoke(a.id);
  assert.equal(s.redeem(a.code, T0).ok, false);
  assert.equal(s.open(T0).length, 0);
});

test("default Argon2id parameters are fixed and sane", async () => {
  const { DEFAULT_ARGON2 } = await import("../src/pair-code.ts");
  assert.deepEqual(DEFAULT_ARGON2, { memoryKiB: 19456, passes: 2, parallelism: 1 });
});
