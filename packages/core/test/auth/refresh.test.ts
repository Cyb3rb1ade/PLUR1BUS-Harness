import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RefreshOwner, RefreshRejected, type Refresher, type RefreshResult } from "../../src/auth/refresh.ts";
import { InMemorySecretStore, decodeRecord, encodeRecord } from "../../src/auth/secret-store.ts";
import { validateProfile } from "../../src/auth/profile.ts";
import { FakeClock, MARK } from "./helpers.ts";

const profile = validateProfile({ id: "e:oauth", display_name: "Example", kind: "oauth_pkce", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", authorization_endpoint: "https://e.test/a", token_endpoint: "https://e.test/t", refresh: { mode: "rotating", refresh_skew_seconds: 120 }, policy_status: "allowed", policy_source: "https://e.test", policy_checked: "2026-09-22" });
const REF = "e/oauth/1";

/** Scripted refresher: counts calls, can be gated, and spends refresh tokens single-use like a rotating vendor. */
function vendor(clock: FakeClock) {
  let n = 0; let gate: Promise<void> | undefined; let valid = new Set<string>([MARK.refresh]); let failWith: RefreshRejected | undefined;
  const r: Refresher & { calls: number; hold(): () => void; fail(f?: RefreshRejected): void } = {
    get calls() { return n; },
    hold() { let open!: () => void; gate = new Promise<void>((res) => { open = res; }); return open; },
    fail(f) { failWith = f; },
    async refresh({ refreshToken }): Promise<RefreshResult> {
      n++;
      if (gate) await gate;
      if (failWith) throw failWith;
      if (!valid.has(refreshToken)) throw new RefreshRejected("invalid_grant"); // reuse of a spent token
      valid.delete(refreshToken);
      const next = `${MARK.refresh}-${n}`; valid.add(next);
      return { accessToken: `${MARK.access}-${n}`, refreshToken: next, expiresInSeconds: 3600 };
    },
  };
  void clock;
  return r;
}
async function seed(store: InMemorySecretStore, clock: FakeClock, over: object = {}) {
  await store.set(REF, encodeRecord({ v: 1, accessToken: MARK.access, refreshToken: MARK.refresh, expiresAt: clock.now() + 60_000, generation: 0, ...over }));
}

describe("refresh owner", () => {
  it("N concurrent callers share exactly one refresh (M2 acceptance 2)", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(), v = vendor(clock);
    await seed(store, clock); // 60 s left: inside the 120 s skew
    const open = v.hold();
    const owner = new RefreshOwner({ store, clock, refresher: v });
    const all = Promise.all(Array.from({ length: 10 }, () => owner.fresh(profile, REF, "c1")));
    await new Promise((r) => setImmediate(r));
    open();
    const res = await all;
    assert.equal(v.calls, 1);
    assert.ok(res.every((r) => r.record.accessToken === `${MARK.access}-1` && r.record.generation === 1));
    // a late caller finds the stored fresh token and does not refresh again
    const late = await owner.fresh(profile, REF, "c1");
    assert.equal(v.calls, 1); assert.equal(late.refreshed, false);
  });

  it("a new owner over the same store continues with the rotated token (refresh survives a restart)", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(), v = vendor(clock);
    await seed(store, clock);
    await new RefreshOwner({ store, clock, refresher: v }).fresh(profile, REF, "c1");
    const stored = decodeRecord((await store.get(REF))!, profile.id);
    assert.equal(stored.refreshToken, `${MARK.refresh}-1`);
    clock.advance(3_500_000); // the rotated access token is near expiry; a "restarted" core has a new owner
    const second = await new RefreshOwner({ store, clock, refresher: v }).fresh(profile, REF, "c1");
    assert.equal(v.calls, 2); // the second refresh used the rotated token, so the vendor accepted it
    assert.equal(second.record.generation, 2);
  });

  it("an expired refresh token is a clear re-auth error and stops further attempts", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(), v = vendor(clock);
    await seed(store, clock);
    v.fail(new RefreshRejected("invalid_grant"));
    const owner = new RefreshOwner({ store, clock, refresher: v });
    await assert.rejects(owner.fresh(profile, REF, "c1"), (e: any) => e.code === "reauth_required" && e.action === "plur1bus login e:oauth" && /sign in again/i.test(e.message) && e.profileId === "e:oauth");
    await assert.rejects(owner.fresh(profile, REF, "c1"), (e: any) => e.code === "reauth_required");
    assert.equal(v.calls, 1); // the dead token is not presented again
    // after a new login replaces the record, refresh resumes
    v.fail(undefined);
    await seed(store, clock);
    assert.equal((await owner.fresh(profile, REF, "c1")).refreshed, true);
    assert.equal(v.calls, 2);
  });

  it("a known refresh-token expiry is re-auth without calling the vendor", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(), v = vendor(clock);
    await seed(store, clock, { refreshExpiresAt: clock.now() - 1 });
    await assert.rejects(new RefreshOwner({ store, clock, refresher: v }).fresh(profile, REF, "c1"), (e: any) => e.code === "reauth_required");
    assert.equal(v.calls, 0);
  });

  it("a transient failure keeps the login: old token used inside the skew window, retryable error after expiry", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(), v = vendor(clock);
    await seed(store, clock);
    v.fail(new RefreshRejected("transient"));
    const owner = new RefreshOwner({ store, clock, refresher: v });
    const ok = await owner.fresh(profile, REF, "c1");
    assert.equal(ok.record.accessToken, MARK.access);
    clock.advance(120_000);
    await assert.rejects(owner.fresh(profile, REF, "c1"), (e: any) => e.code === "refresh_failed" && e.retryable);
    v.fail(undefined);
    assert.equal((await owner.fresh(profile, REF, "c1")).record.generation, 1); // recovered; never marked reauth
  });

  it("an unknown refresher error is transient and its message never surfaces", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore();
    await seed(store, clock, { expiresAt: clock.now() - 1 });
    const owner = new RefreshOwner({ store, clock, refresher: { async refresh({ refreshToken }) { throw new Error(`boom ${refreshToken}`); } } });
    await assert.rejects(owner.fresh(profile, REF, "c1"), (e: any) => e.code === "refresh_failed" && !JSON.stringify(e).includes(MARK.refresh) && !e.message.includes(MARK.refresh));
  });

  it("a rotated token the store refuses is kept and persisted on the next access", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(), v = vendor(clock);
    await seed(store, clock);
    store.failSets = 1;
    const owner = new RefreshOwner({ store, clock, refresher: v });
    const r = await owner.fresh(profile, REF, "c1");
    assert.equal(r.record.generation, 1);
    assert.equal(decodeRecord((await store.get(REF))!, "p").generation, 0); // not stored yet
    await owner.fresh(profile, REF, "c1");
    assert.equal(decodeRecord((await store.get(REF))!, "p").generation, 1); // persisted by the retry
    assert.equal(v.calls, 1);
  });

  it("invalidate forces one refresh, and a stale generation is ignored", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(), v = vendor(clock);
    await seed(store, clock, { expiresAt: clock.now() + 3_600_000 });
    const owner = new RefreshOwner({ store, clock, refresher: v });
    await owner.invalidate(profile, REF, "c1", 5); // wrong generation
    assert.equal((await owner.fresh(profile, REF, "c1")).refreshed, false);
    await owner.invalidate(profile, REF, "c1", 0);
    assert.equal((await owner.fresh(profile, REF, "c1")).refreshed, true);
    assert.equal(v.calls, 1);
  });

  it("no stored credential is a typed error", async () => {
    const owner = new RefreshOwner({ store: new InMemorySecretStore(), clock: new FakeClock(), refresher: vendor(new FakeClock()) });
    await assert.rejects(owner.fresh(profile, REF, "c1"), (e: any) => e.code === "no_credential");
  });
});
