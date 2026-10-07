import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CredentialPool, classifyFailure, COOLDOWN_MS, type Strategy } from "../../src/auth/pool.ts";
import { FakeClock } from "./helpers.ts";

const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, secretRef: `ref/${i + 1}` }));
const mk = (n: number, strategy: Strategy = "fill_first") => { const clock = new FakeClock(); return { clock, pool: new CredentialPool({ profileId: "e:key", entries: entries(n), strategy, clock }) }; };

describe("failure classifier", () => {
  it("table", () => {
    const rows: Array<[Parameters<typeof classifyFailure>[0], string | null, string?, string?]> = [
      [{ status: 429 }, "rate_limited", "ambiguous", "credential"],
      [{ status: 429, model: "m" }, "rate_limited", "ambiguous", "model"],
      [{ status: 429, hint: "quota_exhausted" }, "quota_exhausted", "confirmed", "credential"],
      [{ status: 401 }, "auth_rejected", "confirmed", "credential"],
      [{ status: 403, model: "m" }, "forbidden", "ambiguous", "model"],
      [{ status: 500 }, null], [{ status: 200 }, null], [{ status: 404 }, null],
    ];
    for (const [f, code, cert, scope] of rows) {
      const c = classifyFailure(f);
      assert.equal(c?.code ?? null, code); if (c) { assert.equal(c.certainty, cert); assert.equal(c.scope, scope); }
    }
  });
});

describe("credential pool failover with cooldown (fake clock)", () => {
  it("429 on the first credential fails over, and the cooldown expires", () => {
    const { clock, pool } = mk(2);
    assert.equal(pool.select().id, "c1");
    const r = pool.reportFailure("c1", { status: 429 })!;
    assert.equal(r.cooldownMs, COOLDOWN_MS.ambiguous.several);
    assert.equal(pool.select().id, "c2");
    clock.advance(COOLDOWN_MS.ambiguous.several - 1);
    assert.equal(pool.select().id, "c2");
    clock.advance(1);
    assert.equal(pool.select().id, "c1"); // fill_first returns to the first once it is usable
  });

  it("401 is a confirmed, long cooldown", () => {
    const { clock, pool } = mk(2);
    assert.equal(pool.reportFailure("c1", { status: 401 })!.cooldownMs, COOLDOWN_MS.confirmed.several);
    clock.advance(COOLDOWN_MS.confirmed.several - 1);
    assert.equal(pool.select().id, "c2");
    clock.advance(1);
    assert.equal(pool.select().id, "c1");
  });

  it("the sole credential cools much shorter than one of several; remaining-sole counts too", () => {
    const solo = mk(1);
    assert.equal(solo.pool.reportFailure("c1", { status: 429, hint: "quota_exhausted" })!.cooldownMs, COOLDOWN_MS.confirmed.sole);
    assert.ok(COOLDOWN_MS.confirmed.sole * 5 <= COOLDOWN_MS.confirmed.several && COOLDOWN_MS.ambiguous.sole < COOLDOWN_MS.ambiguous.several);
    const two = mk(2);
    two.pool.reportFailure("c1", { status: 401 });
    assert.equal(two.pool.reportFailure("c2", { status: 429 })!.cooldownMs, COOLDOWN_MS.ambiguous.sole); // c1 already cooling: c2 is the sole one left
  });

  it("all cooling down: typed error with the earliest retry time", () => {
    const { clock, pool } = mk(2);
    pool.reportFailure("c1", { status: 429, retryAfterMs: 30_000 });
    pool.reportFailure("c2", { status: 429, retryAfterMs: 10_000 });
    assert.throws(() => pool.select(), (e: any) => e.code === "all_cooling_down" && e.retryable && e.retryAfterMs === 10_000);
    clock.advance(10_000);
    assert.equal(pool.select().id, "c2");
  });

  it("Retry-After replaces the table value, clamped; a cooldown is never shortened", () => {
    const { pool } = mk(2);
    assert.equal(pool.reportFailure("c1", { status: 429, retryAfterMs: 5 })!.cooldownMs, 1_000);
    assert.equal(pool.reportFailure("c1", { status: 429, retryAfterMs: 10 ** 12 })!.cooldownMs, 86_400_000);
    pool.reportFailure("c1", { status: 429, retryAfterMs: 2_000 });
    assert.equal(pool.status()[0]!.cooldownRemainingMs, 86_400_000);
  });

  it("an ambiguous 429 for one model cools that model only", () => {
    const { clock, pool } = mk(1);
    pool.reportFailure("c1", { status: 429, model: "big" });
    assert.throws(() => pool.select({ model: "big" }), (e: any) => e.code === "all_cooling_down");
    assert.equal(pool.select({ model: "small" }).id, "c1");
    assert.equal(pool.select().id, "c1");
    assert.deepEqual(Object.keys(pool.status()[0]!.modelCooldowns), ["big"]);
    clock.advance(COOLDOWN_MS.ambiguous.sole);
    assert.equal(pool.select({ model: "big" }).id, "c1");
  });

  it("5xx and other statuses cool nothing; success ends an ambiguous cooldown early, not a confirmed one", () => {
    const { pool } = mk(2);
    assert.equal(pool.reportFailure("c1", { status: 503 }), null);
    assert.equal(pool.select().id, "c1");
    pool.reportFailure("c1", { status: 429 }); pool.reportSuccess("c1");
    assert.equal(pool.select().id, "c1");
    pool.reportFailure("c1", { status: 401 }); pool.reportSuccess("c1");
    assert.equal(pool.select().id, "c2");
  });
});

describe("selection strategies", () => {
  it("round_robin rotates and skips cooling credentials", () => {
    const { pool } = mk(3, "round_robin");
    assert.deepEqual([1, 2, 3, 4].map(() => pool.select().id), ["c1", "c2", "c3", "c1"]);
    pool.reportFailure("c2", { status: 429 });
    assert.deepEqual([1, 2, 3].map(() => pool.select().id), ["c3", "c1", "c3"]);
  });
  it("least_used balances by use count", () => {
    const { pool } = mk(3, "least_used");
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => pool.select().id), ["c1", "c2", "c3", "c1", "c2", "c3"]);
  });
  it("fill_first sticks to the first", () => {
    const { pool } = mk(2);
    assert.deepEqual([1, 2, 3].map(() => pool.select().id), ["c1", "c1", "c1"]);
  });
  it("status shows cooldown remaining and last error classification; snapshot restores", () => {
    const { clock, pool } = mk(2);
    pool.reportFailure("c1", { status: 429, hint: "quota_exhausted" });
    const s = pool.status()[0]!;
    assert.equal(s.cooldownRemainingMs, COOLDOWN_MS.confirmed.several);
    assert.deepEqual(s.lastError, { code: "quota_exhausted", certainty: "confirmed" });
    const copy = new CredentialPool({ profileId: "e:key", entries: entries(2), clock });
    copy.restore(JSON.parse(JSON.stringify(pool.snapshot())));
    assert.equal(copy.select().id, "c2");
  });
  it("an empty pool and duplicate ids are refused", () => {
    assert.throws(() => mk(0).pool.select(), (e: any) => e.code === "no_credential");
    assert.throws(() => new CredentialPool({ profileId: "p", entries: [entries(1)[0]!, entries(1)[0]!], clock: new FakeClock() }));
  });
});
