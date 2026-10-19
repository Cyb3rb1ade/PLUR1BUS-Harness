// b14 audit: each test below was written red first (see the commit messages for the fix it belongs to).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createCallBudget } from "../../src/budget/calls.ts";
import { RetryBudget } from "../../src/budget/retry.ts";
import { capSubagentResult } from "../../src/budget/subagent.ts";
import { BudgetInputError, createBudgetService, type BudgetService } from "../../src/budget/service.ts";
import { BudgetStoreError, openBudgetDb } from "../../src/budget/store.ts";
import { open } from "./helpers.ts";

const PROTO_NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];

describe("b14: prototype keys as model names", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });

  it("an Object.prototype member name as a model is counted in tokens like any other (no price lookup exists)", () => {
    const { svc } = open(); closers.push(() => svc.close());
    svc.setLimit({ scope: "global", period: "day", metric: "tokens", hard: 1000 });
    for (const m of PROTO_NAMES) {
      assert.equal(svc.check("a1", m, { inputTokens: 5_000_000, outputTokens: 5_000_000 }).breaches[0]?.kind, "hard", m);
      assert.deepEqual(svc.recordUsage({ agent: "a1", model: m, inputTokens: 10, outputTokens: 10 }), { recorded: true }, m);
    }
    assert.equal(svc.status().periods[0]!.total.inputTokens, 10 * PROTO_NAMES.length);
    const f = open(); closers.push(() => f.svc.close());
    const gate = createCallBudget({ path: f.path, clock: f.clock }); closers.push(() => gate.close());
    gate.setLimit({ scope: "agent", id: "a1", period: "day", metric: "tokens", hard: 15 });
    const d = gate.checkBeforeCall({ principal: "u1", project: "p1", agent: "a1", model: "toString", estimatedInputTokens: 10, maxOutputTokens: 10 });
    assert.equal(d.kind, "refuse");
    if (d.kind === "refuse") assert.equal(d.reason, "hard");
  });
});

describe("b14: ledger input validation", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });

  it("a token sum beyond the safe-integer range is refused instead of poisoning every later read", () => {
    const { svc } = open(); closers.push(() => svc.close());
    assert.throws(() => svc.recordUsage({ agent: "a1", model: "m-large", inputTokens: 2 ** 52, outputTokens: 2 ** 52 }), BudgetInputError);
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
      path: f.path, clock: f.clock,
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
