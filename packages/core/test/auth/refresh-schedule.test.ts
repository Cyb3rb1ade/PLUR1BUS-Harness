import { it } from "node:test";
import assert from "node:assert/strict";
import { RefreshOwner, RefreshRejected, type RefreshTimer } from "../../src/auth/refresh.ts";
import { InMemorySecretStore, encodeRecord } from "../../src/auth/secret-store.ts";
import { validateProfile } from "../../src/auth/profile.ts";
import { FakeClock, MARK } from "./helpers.ts";
const profile = validateProfile({ id: "test:refresh", display_name: "Test", kind: "oauth_pkce", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", authorization_endpoint: "https://example.test/a", token_endpoint: "https://example.test/t", refresh: { mode: "rotating" }, policy_status: "allowed", policy_source: "https://example.test/p", policy_checked: "2026-10-07" });
class Timer implements RefreshTimer {
  callback: (() => void) | undefined; delay = 0;
  schedule(callback: () => void, delay: number) { this.callback = callback; this.delay = delay; return () => { if (this.callback === callback) this.callback = undefined; }; }
  async fire(clock: FakeClock) { clock.advance(this.delay); const cb = this.callback; this.callback = undefined; cb?.(); await new Promise(resolve => setImmediate(resolve)); }
}
it("proactive jitter refreshes before expiry without a turn and shares the single owner", async () => {
  const clock = new FakeClock(), store = new InMemorySecretStore(), timer = new Timer(); let calls = 0;
  await store.set("test/r", encodeRecord({ v: 1, accessToken: MARK.access, refreshToken: MARK.refresh, expiresAt: clock.now() + 3_600_000, generation: 0 }));
  const owner = new RefreshOwner({ store, clock, timer, random: () => 1, refresher: { refresh: async () => { calls++; return { accessToken: "CANARY-NEXT", refreshToken: "CANARY-ROTATED", expiresInSeconds: 3600 }; } } });
  await owner.fresh(profile, "test/r", "a"); assert.equal(calls, 0); assert.equal(timer.delay, 3_450_000);
  await timer.fire(clock); assert.equal(calls, 1); assert.ok(timer.callback);
  owner.close(); assert.equal(timer.callback, undefined);
});
it("transient failures back off across turns, retain valid token, and retry on schedule", async () => {
  const clock = new FakeClock(), store = new InMemorySecretStore(), timer = new Timer(); let calls = 0, failed = true;
  await store.set("test/r", encodeRecord({ v: 1, accessToken: MARK.access, refreshToken: MARK.refresh, expiresAt: clock.now() + 20_000, generation: 0 }));
  const owner = new RefreshOwner({ store, clock, timer, random: () => 0, refresher: { refresh: async () => { calls++; if (failed) throw new RefreshRejected("transient"); return { accessToken: MARK.access, expiresInSeconds: 3600 }; } } });
  await owner.fresh(profile, "test/r", "a"); await owner.fresh(profile, "test/r", "a"); assert.equal(calls, 1); assert.equal(timer.delay, 1000);
  await timer.fire(clock); assert.equal(calls, 2); assert.equal(timer.delay, 2000);
  clock.advance(25_000);
  // Once the retry deadline has passed an expired token triggers a call, then a bounded retry error.
  await assert.rejects(owner.fresh(profile, "test/r", "a"), (e: any) => e.code === "refresh_failed" && e.retryAfterMs > 0);
  failed = false; await timer.fire(clock); assert.equal(calls, 4); owner.close();
});
