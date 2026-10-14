// b14 audit: each test below was written red first (see the commit messages for the fix it belongs to).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createCallBudget } from "../../src/budget/calls.ts";
import { PriceBook, costMicros, mediaCostMicros, type PriceTable } from "../../src/budget/prices.ts";
import { RetryBudget } from "../../src/budget/retry.ts";
import { capSubagentResult } from "../../src/budget/subagent.ts";
import { BudgetInputError, createBudgetService, type BudgetService } from "../../src/budget/service.ts";
import { BudgetStoreError, openBudgetDb } from "../../src/budget/store.ts";
import { open, PRICES_V1 } from "./helpers.ts";

const PROTO_NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];

describe("b14: prototype keys are not model prices (hard cost limit bypass)", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });

  it("costMicros treats an Object.prototype member name as an unpriced model", () => {
    for (const m of PROTO_NAMES) assert.equal(costMicros(PRICES_V1, m, undefined, { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }), null, m);
    assert.equal(costMicros(PRICES_V1, "m-small", "constructor", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), 6);
  });

  it("check() refuses such a model under a hard cost limit and recordUsage stores it unpriced", () => {
    const { svc } = open(); closers.push(() => svc.close());
    svc.setLimit({ scope: "global", period: "day", metric: "cost", hard: 1000 });
    for (const m of PROTO_NAMES) {
      const d = svc.check("a1", m, { inputTokens: 5_000_000, outputTokens: 5_000_000 });
      assert.equal(d.allowed, false, m);
      assert.equal(d.breaches[0]?.kind, "unpriced-model", m);
      assert.equal(svc.recordUsage({ agent: "a1", model: m, inputTokens: 10, outputTokens: 10 }).costMicros, null, m);
    }
  });

  it("the call port refuses with unpriced-model instead of throwing", () => {
    const f = open(); closers.push(() => f.svc.close());
    const gate = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]) }); closers.push(() => gate.close());
    gate.setLimit({ scope: "agent", id: "a1", period: "day", metric: "cost", hard: 1000 });
    const d = gate.checkBeforeCall({ principal: "u1", project: "p1", agent: "a1", model: "toString", estimatedInputTokens: 10, maxOutputTokens: 10 });
    assert.equal(d.kind, "refuse");
    if (d.kind === "refuse") assert.equal(d.reason, "unpriced-model");
  });

  it("an Object.prototype member name as media resolution is unpriced, not a thrown RangeError", () => {
    const t: PriceTable = { version: "m", effectiveFrom: 0, models: { img: { input: 1, output: 1, media: { image: { "1024": 40_000 } } } } };
    assert.equal(mediaCostMicros(t, "img", undefined, [{ kind: "image", resolution: "constructor", quantity: 1 }]), null);
    assert.equal(mediaCostMicros(t, "img", undefined, [{ kind: "image", resolution: "1024", quantity: 1 }]), 40_000);
  });
});

describe("b14: ledger input validation", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });

  it("a cost beyond the safe-integer range is refused instead of poisoning every later read", () => {
    const { svc } = open(); closers.push(() => svc.close());
    assert.throws(() => svc.recordUsage({ agent: "a1", model: "m-large", inputTokens: 2 ** 50, outputTokens: 0 }), BudgetInputError);
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 10, outputTokens: 10 });
    assert.equal(svc.status().periods[0]!.total.events, 1);
  });

  it("a timestamp outside the Date range is a BudgetInputError, also with limits configured", () => {
    const { svc } = open(); closers.push(() => svc.close());
    svc.setLimit({ scope: "global", period: "day", metric: "tokens", hard: 100 });
    assert.throws(() => svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1, outputTokens: 1, ts: 9_000_000_000_000_000 }), BudgetInputError);
    assert.equal(svc.status().periods[0]!.total.events, 0);
  });

  it("opening a file that is not a database fails with a BudgetStoreError", () => {
    const { dir } = open();
    const path = `${dir}/state/garbage.sqlite`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "this is not an sqlite database, just text padding".repeat(40));
    assert.throws(() => openBudgetDb({ path }), (e: unknown) => e instanceof BudgetStoreError && e.code === "open-failed");
  });
});

describe("b14: notices and events", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });

  it("crossing the hard limit does not later also announce the soft limit", () => {
    const { svc, events } = open(); closers.push(() => svc.close());
    svc.setLimit({ scope: "global", period: "day", metric: "tokens", soft: 100, hard: 200 });
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 250, outputTokens: 0 }); // straight past both
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 10, outputTokens: 0 });
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 10, outputTokens: 0 });
    assert.deepEqual(events.map((e) => e.kind), ["budget.hard"]);
  });

  it("a sink may call back into the service: events are delivered after the commit", () => {
    const f = open(); f.svc.close();
    const calls: string[] = [];
    let svc!: BudgetService;
    svc = createBudgetService({
      path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]),
      events: (e) => { if (e.kind === "budget.hard") { svc.setLimit({ scope: "global", period: "day", metric: "tokens", hard: 1 }); calls.push("throttled"); } },
    });
    closers.push(() => svc.close());
    svc.setLimit({ scope: "global", period: "day", metric: "tokens", hard: 100 });
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 150, outputTokens: 0 });
    assert.deepEqual(calls, ["throttled"]);
    assert.equal(svc.limits()[0]!.hard, 1);
  });
});

describe("b14: retry budget and subagent cap", () => {
  it("an unknown failure class is refused, also when it is an Object.prototype member name", () => {
    const rb = new RetryBudget();
    for (const c of ["toString", "constructor", "__proto__", "hasOwnProperty"]) assert.throws(() => rb.consume("t1", c as never, 0), RangeError, c);
  });

  it("a result that cannot be serialised is a RangeError, not a raw TypeError", () => {
    const circular: Record<string, unknown> = {}; circular["self"] = circular;
    assert.throws(() => capSubagentResult(circular, { port: { store: () => "p1" } }), RangeError);
    assert.throws(() => capSubagentResult({ n: 1n }, { port: { store: () => "p1" } }), RangeError);
  });
});
