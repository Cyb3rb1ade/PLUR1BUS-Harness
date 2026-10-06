import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BudgetInputError } from "../../src/budget/service.ts";
import { BUDGET_SCHEMA_VERSION, BudgetStoreError, openBudgetDb } from "../../src/budget/store.ts";
import { open } from "./helpers.ts";

describe("recordUsage", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });
  const mk = (...a: Parameters<typeof open>) => { const r = open(...a); closers.push(() => r.svc.close()); return r; };

  it("records counts and prices them at record time", () => {
    const { svc } = mk();
    const r = svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 100 });
    assert.deepEqual(r, { recorded: true, costMicros: 1000 + 1000 + 50 + 125, priceVersion: "v1" });
    const s = svc.status();
    const day = s.periods[0]!;
    assert.equal(day.key, "2026-10-06");
    assert.equal(day.total.events, 1);
    assert.equal(day.total.costMicros, 2175);
    assert.deepEqual(day.agents[0]!.models.map((m) => [m.model, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheWriteTokens]), [["m-small", 1000, 200, 500, 100]]);
  });

  it("accounts per (agent, model, day/month) and rolls the day over with the clock", () => {
    const { svc, clock } = mk();
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 10, outputTokens: 10 });
    svc.recordUsage({ agent: "a1", model: "m-large", inputTokens: 10, outputTokens: 10 });
    svc.recordUsage({ agent: "a2", model: "m-small", inputTokens: 10, outputTokens: 10 });
    clock.advance(24 * 3_600_000); // 7 Oct
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 5, outputTokens: 5 });
    const s = svc.status();
    const [day, month] = s.periods;
    assert.equal(day!.key, "2026-10-07");
    assert.equal(day!.total.events, 1);
    assert.equal(month!.key, "2026-10");
    assert.equal(month!.total.events, 4);
    assert.deepEqual(month!.agents.map((a) => [a.agentId, a.models.map((m) => m.model)]), [["a1", ["m-large", "m-small"]], ["a2", ["m-small"]]]);
    assert.equal(svc.status({ agentId: "a2" }).periods[1]!.total.events, 1);
  });

  it("a request id makes a retry a no-op", () => {
    const { svc } = mk();
    const e = { agent: "a1", model: "m-small", inputTokens: 10, outputTokens: 10, requestId: "req-1" };
    assert.equal(svc.recordUsage(e).recorded, true);
    assert.equal(svc.recordUsage(e).recorded, false);
    assert.equal(svc.status().periods[0]!.total.events, 1);
  });

  it("an unknown model is recorded unpriced (null cost), counted, and reported", () => {
    const { svc } = mk();
    const r = svc.recordUsage({ agent: "a1", model: "mystery", inputTokens: 10, outputTokens: 10 });
    assert.equal(r.costMicros, null);
    const t = svc.status().periods[0]!.total;
    assert.equal(t.unpricedEvents, 1);
    assert.equal(t.costMicros, 0);
    assert.equal(t.inputTokens, 10);
  });

  it("refuses malformed events with a typed error", () => {
    const { svc } = mk();
    const bad: unknown[] = [
      null, { model: "m", inputTokens: 1, outputTokens: 1 }, { agent: "a", model: "m", inputTokens: -1, outputTokens: 1 },
      { agent: "a", model: "m", inputTokens: 1.5, outputTokens: 1 }, { agent: "a", model: "m", inputTokens: 1, outputTokens: Number.NaN },
      { agent: "a b", model: "m", inputTokens: 1, outputTokens: 1 }, { agent: "a", model: "m", inputTokens: 1, outputTokens: 1, ts: "now" },
    ];
    for (const e of bad) assert.throws(() => svc.recordUsage(e as never), BudgetInputError);
    assert.equal(svc.status().periods[0]!.total.events, 0);
  });
});

describe("no prompt content in the usage store", () => {
  it("refuses any property beyond the closed event shape and any free-text identifier", () => {
    const { svc } = open();
    const secret = "my private prompt: the launch code is 0000";
    for (const extra of ["prompt", "messages", "response", "content", "text", "system", "metadata"]) {
      assert.throws(() => svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1, outputTokens: 1, [extra]: secret } as never), /unknown property/);
    }
    for (const field of ["agent", "model", "provider", "requestId"]) {
      assert.throws(() => svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1, outputTokens: 1, [field]: secret } as never), BudgetInputError);
    }
    assert.throws(() => svc.check("a1", "m-small", { inputTokens: 1, prompt: secret } as never), /unknown property/);
    svc.close();
  });

  it("the schema has no column that can hold content: only ids and integers", () => {
    const { svc, path } = open();
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1, outputTokens: 1 });
    svc.close();
    const db = new DatabaseSync(path, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    const cols: Record<string, string[]> = {};
    for (const t of tables) cols[t.name] = (db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string; type: string }[]).map((c) => `${c.name}:${c.type}`);
    db.close();
    assert.deepEqual(Object.keys(cols).sort(), ["budget_limit", "notice", "settings", "usage_event"]);
    assert.deepEqual(cols.usage_event, ["id:INTEGER", "ts:INTEGER", "agent:TEXT", "provider:TEXT", "model:TEXT", "input_tokens:INTEGER", "output_tokens:INTEGER", "cache_read_tokens:INTEGER", "cache_write_tokens:INTEGER", "cost_micros:INTEGER", "price_version:TEXT", "request_id:TEXT"]);
  });

  it("the database files contain none of the rejected content", () => {
    const { svc, path, dir } = open();
    const marker = "ZQXJ-PROMPT-MARKER-91827";
    try { svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1, outputTokens: 1, prompt: marker } as never); } catch { /* refused */ }
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1, outputTokens: 1 });
    svc.close();
    for (const f of readdirSync(join(dir, "state"))) assert.ok(!readFileSync(join(dir, "state", f)).includes(marker), f);
    assert.ok(statSync(path).size > 0);
  });
});

describe("store", () => {
  it("is migrated, persists across reopen, and the file is owner-only", () => {
    const { svc, dir, path, clock } = open();
    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 7, outputTokens: 3 });
    svc.setTimeZone("Europe/Berlin");
    svc.close();
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0);
    const again = open({ dir, clock });
    assert.equal(again.svc.status().periods[1]!.total.inputTokens, 7);
    assert.equal(again.svc.timeZone(), "Europe/Berlin");
    again.svc.close();
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, BUDGET_SCHEMA_VERSION);
    db.close();
  });

  it("refuses a store written by a newer core instead of touching it", () => {
    const { svc, path } = open();
    svc.close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${BUDGET_SCHEMA_VERSION + 1}`);
    db.close();
    assert.throws(() => openBudgetDb({ path }), (e: unknown) => e instanceof BudgetStoreError && e.code === "newer-schema");
  });
});
