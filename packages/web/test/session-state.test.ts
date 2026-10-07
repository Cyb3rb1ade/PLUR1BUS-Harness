import assert from "node:assert/strict";
import { test } from "node:test";
import { setLangPref } from "../src/i18n.ts";
import { configureSession, initSession, sessionNotice, sessionState, sessionWrite, signIn, signOut, type SessionApi, type WriteFailure } from "../src/session.ts";
import { writeFailureText } from "../src/session-text.ts";

function fake(over: Partial<SessionApi>): SessionApi {
  return {
    whoami: async () => null,
    login: async () => ({ ok: true, user: { id: "owner", role: "owner" } }),
    write: async () => ({ ok: true, status: 200, body: null }),
    logout: async () => {},
    ...over,
  };
}

test("a write that finds the session expired signs the UI out with the expiry notice; signing in clears it", async () => {
  configureSession(fake({ write: async () => ({ ok: false, failure: { kind: "session-expired" } }) }));
  assert.equal((await signIn("x".repeat(40))).ok, true);
  assert.equal(sessionState.value.status, "authenticated");
  const r = await sessionWrite("POST", "/api/v1/anything", {});
  assert.deepEqual(r, { ok: false, failure: { kind: "session-expired" } });
  assert.equal(sessionState.value.status, "anonymous");
  assert.equal(sessionNotice.value, "expired");
  await signIn("x".repeat(40));
  assert.equal(sessionNotice.value, null);
});

test("a csrf failure leaves the session in place", async () => {
  configureSession(fake({ write: async () => ({ ok: false, failure: { kind: "csrf" } }) }));
  await signIn("x".repeat(40));
  await sessionWrite("POST", "/api/v1/anything");
  assert.equal(sessionState.value.status, "authenticated");
  assert.equal(sessionNotice.value, null);
});

test("initSession and signOut follow whoami and logout", async () => {
  configureSession(fake({ whoami: async () => ({ id: "owner", role: "owner" }) }));
  await initSession();
  assert.equal(sessionState.value.status, "authenticated");
  await signOut();
  assert.equal((sessionState.value as { status: string }).status, "anonymous");
  configureSession(fake({ whoami: async () => { throw new Error("down"); } }));
  await initSession();
  assert.equal((sessionState.value as { status: string }).status, "anonymous");
});

test("every write failure has a non-empty text in en and de", () => {
  const all: WriteFailure[] = [{ kind: "session-expired" }, { kind: "csrf" }, { kind: "rate-limited", retryAfterSeconds: 3 }, { kind: "network" }, { kind: "server", status: 502 }];
  const seen = new Map<string, Set<string>>();
  for (const lang of ["en", "de"] as const) {
    setLangPref(lang);
    for (const f of all) {
      const text = writeFailureText(f);
      assert.ok(text.trim().length > 0 && !text.includes("{"), `${lang} ${f.kind}`);
      seen.set(f.kind, (seen.get(f.kind) ?? new Set()).add(text));
    }
  }
  for (const [k, texts] of seen) assert.equal(texts.size, 2, `${k}: en and de differ`);
  setLangPref("en");
});
