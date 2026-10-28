// RE-D29 (RE-14/P5): the weight with which cache reads count against token limits, a budget setting beside the time
// zone. Provider adapters report `inputTokens` as the whole prompt, cache reads and writes included; a token limit
// counts input - cacheRead × (1 - w) + output. Weight 1, the default, is the behaviour from before the setting.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createCallBudget, type ActualCallUsage, type CallBudgetEvent, type CallScope,
} from "../../src/budget/calls.ts";
import type { CallPeriod } from "../../src/budget/period.ts";
import { open } from "./helpers.ts";

const SET_STORED = "INSERT OR REPLACE INTO settings (key, value) VALUES ('cache_read_weight', ?)";

describe("cache-read weight setting", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const c of closers.splice(0)) c();
  });
  const mk = (...a: Parameters<typeof open>) => {
    const r = open(...a);
    closers.push(() => r.svc.close());
    return r;
  };

  it("starts at full weight and keeps a set weight across a reopen", () => {
    const first = open();
    assert.equal(first.svc.cacheReadWeight(), 1);
    assert.equal(first.svc.setCacheReadWeight(0.1), 0.1);
    assert.equal(first.svc.cacheReadWeight(), 0.1);
    first.svc.close();
    const again = mk({ dir: first.dir, clock: first.clock });
    assert.equal(again.svc.cacheReadWeight(), 0.1);
    assert.equal(again.svc.setCacheReadWeight(0), 0);
    assert.equal(again.svc.cacheReadWeight(), 0);
    assert.equal(again.svc.setCacheReadWeight(1), 1);
    assert.equal(again.svc.cacheReadWeight(), 1);
  });

  it("refuses a weight below 0, above 1, not finite or not a number, and keeps the stored one", () => {
    const { svc } = mk();
    svc.setCacheReadWeight(0.5);
    const bad = [
      -0.01, 1.01, -1, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.5", null, undefined, {},
    ];
    for (const w of bad) {
      const refused = (e: unknown) => e instanceof RangeError && /cache read weight/.test(e.message);
      assert.throws(() => svc.setCacheReadWeight(w as never), refused, String(w));
    }
    assert.equal(svc.cacheReadWeight(), 0.5);
  });

  it("applies a weight in millionths: a finer value is rounded to the nearest millionth", () => {
    const { svc } = mk();
    assert.equal(svc.setCacheReadWeight(0.1234567), 0.123457);
    assert.equal(svc.cacheReadWeight(), 0.123457);
    assert.equal(svc.setCacheReadWeight(0.0000004), 0);
  });

  it("reads a stored weight it cannot parse as full weight, so every cache read counts", () => {
    const { svc, path } = mk();
    const db = new DatabaseSync(path);
    try {
      for (const value of ["", " ", "abc", "-0.5", "1.5", "NaN", "Infinity"]) {
        db.prepare(SET_STORED).run(value);
        assert.equal(svc.cacheReadWeight(), 1, JSON.stringify(value));
      }
    } finally {
      db.close();
    }
  });
});

describe("token limits count cache reads with the weight", () => {
  const call = {
    principal: "u1", project: "p1", agent: "a1", model: "m-small", turn: "t1", session: "s1",
    estimatedInputTokens: 1000, maxOutputTokens: 100,
  };
  /** RE-D29's example call: 1000 input, of which 900 are cache reads and 50 cache writes, and 100 output. */
  const usage: ActualCallUsage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 };
  const SCOPES = [
    ["global", ""], ["agent", "a1"], ["user", "u1"], ["project", "p1"], ["turn", "t1"], ["session", "s1"],
  ] as const;

  function fixture(weight?: number) {
    const f = open();
    if (weight !== undefined) f.svc.setCacheReadWeight(weight);
    const callEvents: CallBudgetEvent[] = [];
    const gate = createCallBudget({ path: f.path, clock: f.clock, emitter: { emit: (e) => callEvents.push(e) } });
    const close = () => {
      gate.close();
      f.svc.close();
    };
    return { ...f, gate, callEvents, close };
  }
  type Fixture = ReturnType<typeof fixture>;

  /** Admits `call` through the call port and settles it with `actual`. */
  function settled(f: Fixture, actual: ActualCallUsage = usage): void {
    const d = f.gate.checkBeforeCall(call);
    if (d.kind !== "allow") return assert.fail(`admission refused: ${JSON.stringify(d)}`);
    f.gate.settle(d.reservationId, actual);
  }

  /** The use a token limit of this scope and period counts now, read from the refusal of a 1-token call at 0. */
  function useOf(f: Fixture, scope: CallScope, id: string, period: CallPeriod): number {
    const limit = { scope, id, period, metric: "tokens" } as const;
    f.gate.setLimit({ ...limit, hard: 0 });
    try {
      const d = f.gate.checkBeforeCall({ ...call, estimatedInputTokens: 1, maxOutputTokens: 0 });
      if (d.kind !== "refuse" || d.scope !== scope) return assert.fail(`no refusal by the ${scope} probe limit`);
      return d.used;
    } finally {
      f.gate.clearLimit(limit);
    }
  }

  /** What the advisory service counts after recording the example call for agent a1, at `weight` (absent: default). */
  function serviceUse(weight?: number): { status: number; check: number } {
    const s = open();
    try {
      if (weight !== undefined) s.svc.setCacheReadWeight(weight);
      s.svc.setLimit({ scope: "agent", agentId: "a1", period: "month", metric: "tokens", hard: 5000 });
      s.svc.recordUsage({ agent: "a1", model: "m-small", ...usage });
      const status = s.svc.status().limits[0]!.used;
      const check = s.svc.check("a1", "m-small", { inputTokens: 5000 }).breaches[0]!.used;
      return { status, check };
    } finally {
      s.svc.close();
    }
  }

  it("weight 1, the default, counts input + output with every cache read in full, in every scope", () => {
    for (const weight of [undefined, 1]) {
      const f = fixture(weight);
      try {
        settled(f);
        for (const [scope, id] of SCOPES) {
          assert.equal(useOf(f, scope, id, "day"), 1100, `${scope}, weight ${weight}`);
        }
      } finally {
        f.close();
      }
      assert.deepEqual(serviceUse(weight), { status: 1100, check: 1100 });
    }
  });

  it("weight 1 counts exactly input + output for any mix of events, also one that reports more reads than input", () => {
    const f = fixture(1);
    try {
      let seed = 7;
      const next = (n: number) => {
        seed = (seed * 48_271) % 2_147_483_647;
        return seed % n;
      };
      let agent = 0;
      let user = 0;
      for (let i = 0; i < 200; i++) {
        const e = {
          inputTokens: next(5000), outputTokens: next(1000), cacheReadTokens: next(6000), cacheWriteTokens: next(500),
        };
        if (i % 2) {
          f.svc.recordUsage({ agent: "a1", model: "m-small", ...e });
        } else {
          settled(f, e);
          user += e.inputTokens + e.outputTokens;
        }
        agent += e.inputTokens + e.outputTokens;
      }
      assert.equal(useOf(f, "agent", "a1", "month"), agent);
      assert.equal(useOf(f, "user", "u1", "month"), user);
    } finally {
      f.close();
    }
  });

  it("counts the example call as 1000 - 900 + 90 + 100 = 290 tokens at weight 0.1 and 200 at weight 0, in every scope", () => {
    for (const [weight, counted] of [[0.1, 290], [0, 200]] as const) {
      const f = fixture(weight);
      try {
        settled(f);
        for (const [scope, id] of SCOPES) {
          assert.equal(useOf(f, scope, id, "day"), counted, `${scope}, weight ${weight}`);
        }
      } finally {
        f.close();
      }
      assert.deepEqual(serviceUse(weight), { status: counted, check: counted });
    }
  });

  it("re-rates usage already settled in the period when the weight changes, in both directions", () => {
    const f = fixture();
    try {
      settled(f);
      assert.equal(useOf(f, "user", "u1", "month"), 1100);
      f.svc.setCacheReadWeight(0.1);
      assert.equal(useOf(f, "user", "u1", "month"), 290);
      assert.equal(useOf(f, "agent", "a1", "month"), 290);
      f.svc.setCacheReadWeight(1);
      assert.equal(useOf(f, "user", "u1", "month"), 1100);
    } finally {
      f.close();
    }
  });

  it("applies the weight within each period: a new day starts from zero, the week, the month and the session keep both days", () => {
    const f = fixture(0.1);
    try {
      settled(f); // Tuesday 6 October 2026
      f.clock.advance(24 * 3_600_000);
      settled(f); // Wednesday, the same week
      for (const [scope, id] of [["agent", "a1"], ["user", "u1"]] as const) {
        assert.equal(useOf(f, scope, id, "day"), 290, scope);
        assert.equal(useOf(f, scope, id, "week"), 580, scope);
        assert.equal(useOf(f, scope, id, "month"), 580, scope);
      }
      assert.equal(useOf(f, "session", "s1", "day"), 580);
    } finally {
      f.close();
    }
  });

  it("admits and refuses on the weighted use: 290 used under a ceiling of 300 leaves exactly 10 tokens", () => {
    const f = fixture(0.1);
    try {
      settled(f);
      f.svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "tokens", hard: 300 });
      const breaches = f.svc.check("a1", "m-small", { inputTokens: 11 }).breaches;
      assert.deepEqual(breaches.map((b) => [b.used, b.estimate]), [[290, 11]]);
      assert.equal(f.svc.check("a1", "m-small", { inputTokens: 10 }).allowed, true);
      const over = f.gate.checkBeforeCall({ ...call, estimatedInputTokens: 11, maxOutputTokens: 0 });
      assert.deepEqual(over.kind === "refuse" ? [over.scope, over.used, over.estimate] : over, ["agent", 290, 11]);
      assert.equal(f.gate.checkBeforeCall({ ...call, estimatedInputTokens: 10, maxOutputTokens: 0 }).kind, "allow");
      f.svc.setCacheReadWeight(1);
      const limit = f.svc.status().limits[0]!;
      assert.deepEqual([limit.used, limit.state], [1100, "hard"]);
    } finally {
      f.close();
    }
  });

  it("reports an overage at settlement only when the weighted use passes the ceiling", () => {
    for (const [weight, overages] of [[0, []], [0.1, [["agent", 290]]], [1, [["agent", 1100]]]] as const) {
      const f = fixture(weight);
      try {
        f.svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "tokens", hard: 250 });
        const d = f.gate.checkBeforeCall({ ...call, estimatedInputTokens: 150, maxOutputTokens: 50 });
        if (d.kind !== "allow") return assert.fail("admission refused");
        const s = f.gate.settle(d.reservationId, usage);
        assert.deepEqual(s.overages.map((o) => [o.scope, o.used]), overages, `weight ${weight}`);
      } finally {
        f.close();
      }
    }
  });

  it("warns on a soft limit only once the weighted use reaches it: 200 stays below 250, 290 and 1100 pass it", () => {
    for (const [weight, warns] of [[0, false], [0.1, true], [1, true]] as const) {
      const f = fixture(weight);
      try {
        // An admission of 200 stays below the soft limit, so only the settled, weighted use can warn.
        f.gate.setLimit({ scope: "project", id: "p1", period: "day", metric: "tokens", soft: 250, hard: 2000 });
        const d = f.gate.checkBeforeCall({ ...call, estimatedInputTokens: 100, maxOutputTokens: 100 });
        if (d.kind !== "allow") return assert.fail("admission refused");
        assert.equal(f.callEvents.some((e) => e.type === "warn"), false);
        f.gate.settle(d.reservationId, usage);
        assert.equal(f.callEvents.some((e) => e.type === "warn"), warns, `call port, weight ${weight}`);
      } finally {
        f.close();
      }
      const s = open();
      try {
        s.svc.setCacheReadWeight(weight);
        s.svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "tokens", soft: 250, hard: 2000 });
        s.svc.recordUsage({ agent: "a1", model: "m-small", ...usage });
        assert.deepEqual(s.events.map((e) => e.kind), warns ? ["budget.soft"] : [], `service, weight ${weight}`);
        assert.equal(s.svc.status().limits[0]!.state, warns ? "soft" : "ok");
      } finally {
        s.svc.close();
      }
    }
  });

  it("holds the unweighted estimate while a call is pending and the weighted use once it is settled", () => {
    const f = fixture(0);
    try {
      f.gate.setLimit({ scope: "user", id: "u1", period: "day", metric: "tokens", hard: 1100 });
      const d = f.gate.checkBeforeCall(call);
      if (d.kind !== "allow") return assert.fail("admission refused");
      assert.equal(d.estimatedTokens, 1100); // cache reads are unknown before the call: the whole input is reserved
      const held = f.gate.checkBeforeCall({ ...call, estimatedInputTokens: 1, maxOutputTokens: 0 });
      assert.deepEqual(held.kind === "refuse" ? [held.used, held.estimate] : held, [1100, 1]);
      f.gate.settle(d.reservationId, usage); // 200 at weight 0
      assert.equal(f.gate.checkBeforeCall({ ...call, estimatedInputTokens: 900, maxOutputTokens: 0 }).kind, "allow");
      assert.equal(f.gate.checkBeforeCall({ ...call, estimatedInputTokens: 1, maxOutputTokens: 0 }).kind, "refuse");
    } finally {
      f.close();
    }
  });

  it("takes off no more than an event's own input, however many cache reads it reports", () => {
    const f = fixture(0);
    try {
      const inconsistent = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 500 };
      f.svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1000, outputTokens: 0 });
      f.svc.recordUsage({ agent: "a1", model: "m-small", ...inconsistent });
      settled(f, inconsistent);
      assert.equal(useOf(f, "agent", "a1", "day"), 1000 + 10 + 10); // each inconsistent event keeps its output
      assert.equal(useOf(f, "user", "u1", "day"), 10);
    } finally {
      f.close();
    }
  });

  it("rounds the weighted share of the reads up to a whole token, once per period sum and without binary drift", () => {
    const cases = [
      [0.1, [901], 91], // 90.1 is rounded up
      [0.07, [100], 7], // 0.07 × 100 is 7.000000000000001 in binary floating point; the share is exactly 7
      [0.1, [5, 5], 1], // two events of 5 reads count like one of 10: 1, not 1 + 1
    ] as const;
    for (const [weight, reads, counted] of cases) {
      const f = fixture(weight);
      try {
        for (const r of reads) {
          f.svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: r, outputTokens: 0, cacheReadTokens: r });
        }
        assert.equal(useOf(f, "global", "", "day"), counted, `${weight} × ${reads.join(" + ")}`);
      } finally {
        f.close();
      }
    }
  });
});
