import { test } from "node:test";
import assert from "node:assert/strict";
import { PairCodeStore, deriveKey } from "../src/pair-code.ts";
import type { Argon2Params, DeriveKey } from "../src/pair-code.ts";

const LIGHT: Argon2Params = { memoryKiB: 64, passes: 1, parallelism: 1 };
const T0 = 1_700_000_000_000;
const MIN = 60_000;

function countingStore(over: Partial<ConstructorParameters<typeof PairCodeStore>[0]> = {}) {
  let calls = 0;
  const derive: DeriveKey = (c, s, p) => { calls++; return deriveKey(c, s, p); };
  const store = new PairCodeStore({ params: LIGHT, derive, ...over });
  return { store, calls: () => calls };
}
const wrong = (code: string) => (code.startsWith("AAAA") ? "BBBB-BBBB" : "AAAA-AAAA");

test("a source is locked after five failures, even for the correct code, and unlocks later", () => {
  const { store } = countingStore();
  const { code } = store.issue(T0);
  for (let i = 0; i < 5; i++) assert.deepEqual(store.redeem(wrong(code), T0 + i * 1000, "10.0.0.9"), { ok: false, reason: "invalid" });
  const locked = store.redeem(code, T0 + 6000, "10.0.0.9");
  assert.equal(locked.ok, false);
  assert.equal((locked as { reason: string }).reason, "locked");
  assert.ok((locked as { retryAfterMs: number }).retryAfterMs > 0);
  assert.equal(store.redeem(code, T0 + 16 * MIN + 5000, "10.0.0.9").ok, true, "after the lock the correct code still works (the code was not burned)");
});

test("failures age out of the window, and a success clears the slate", () => {
  const { store } = countingStore();
  const { code } = store.issue(T0);
  for (let i = 0; i < 4; i++) store.redeem(wrong(code), T0 + i * 1000, "s");
  for (let i = 0; i < 4; i++) store.redeem(wrong(code), T0 + 11 * MIN + i * 1000, "s");
  assert.equal(store.redeem(code, T0 + 12 * MIN, "s").ok, true, "eight failures in two separate windows never lock");
});

test("guessing from many sources burns the code after ten failures in total", () => {
  const { store } = countingStore();
  const { code } = store.issue(T0);
  for (let i = 0; i < 10; i++) store.redeem(wrong(code), T0 + i, `src-${i}`);
  assert.deepEqual(store.redeem(code, T0 + 100, "fresh-source"), { ok: false, reason: "invalid" }, "the real code is dead: 2^40 guesses are out of reach");
  assert.equal(store.open(T0 + 100).length, 0);
});

test("every failure is counted against every open code, and a burned code does not take the others with it", () => {
  const { store } = countingStore();
  const a = store.issue(T0);
  for (let i = 0; i < 9; i++) store.redeem(wrong(a.code), T0 + i, `s${i}`);
  const b = store.issue(T0 + 50);
  store.redeem(wrong(a.code), T0 + 60, "s9");
  const snap = Object.fromEntries(store.snapshot(T0 + 60).map((e) => [e.id, e]));
  assert.equal(snap[a.id]?.used, true, "burned");
  assert.equal(snap[b.id]?.failures, 1, "the newer code saw only the failures after it was issued");
  assert.equal(store.redeem(b.code, T0 + 70, "someone").ok, true);
});

test("the same work happens whatever the input looks like (one derivation per open code, one dummy when none)", () => {
  const { store, calls } = countingStore();
  store.issue(T0);
  store.issue(T0);
  const before = calls();
  const perCall: number[] = [];
  for (const input of ["AAAA-AAAA", "not a code", "", "ÄÄÄÄ-ÄÄÄÄ", "bbbb bbbb"]) {
    const c0 = calls();
    store.redeem(input, T0 + 10, `src-${input.length}`);
    perCall.push(calls() - c0);
  }
  assert.deepEqual(perCall, [2, 2, 2, 2, 2], `from ${before}`);
  const empty = countingStore();
  empty.store.redeem("whatever", T0, "x");
  empty.store.redeem("AAAA-AAAA", T0, "y");
  assert.equal(empty.calls(), 2, "one dummy derivation per call when no code is open");
});

test("a locked source costs no derivation at all", () => {
  const { store, calls } = countingStore();
  const { code } = store.issue(T0);
  for (let i = 0; i < 5; i++) store.redeem(wrong(code), T0 + i, "x");
  const c0 = calls();
  store.redeem(code, T0 + 10, "x");
  assert.equal(calls(), c0);
});
