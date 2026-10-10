// Sessions overview model: filters, sort and paging over metadata; the data layer keeps metadata fields only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { metaOf } from "../src/pages/logs/sessions/data.ts";
import { activityOf, applyFilters, filtersActive, NO_FILTERS, paginate, sortSessions, type SessionMeta } from "../src/pages/logs/sessions/model.ts";
import { makeSessions } from "./activity-fixtures.ts";

const rows = makeSessions(30) as SessionMeta[];

describe("sessions: filters", () => {
  test("default shows active sessions only; archived and all are filters", () => {
    const active = applyFilters(rows, NO_FILTERS);
    assert.ok(active.every((s) => s.archivedAt === null));
    assert.equal(applyFilters(rows, { ...NO_FILTERS, status: "archived" }).length, rows.filter((s) => s.archivedAt !== null).length);
    assert.equal(applyFilters(rows, { ...NO_FILTERS, status: "all" }).length, 30);
  });
  test("text matches title, id and agent, case-insensitively", () => {
    assert.deepEqual(applyFilters(rows, { ...NO_FILTERS, text: "CHAT 003" }).map((s) => s.id), ["ses_003"]);
    assert.deepEqual(applyFilters(rows, { ...NO_FILTERS, text: "ses_004" }).map((s) => s.id), ["ses_004"]);
    assert.ok(applyFilters(rows, { ...NO_FILTERS, text: "bernd" }).every((s) => s.agentId === "bernd"));
  });
  test("agent filter", () => { assert.ok(applyFilters(rows, { ...NO_FILTERS, agent: "ops", status: "all" }).every((s) => s.agentId === "ops")); });
  test("date bounds are inclusive local days on the last activity (created when there was none)", () => {
    const s = (id: string, ms: number): SessionMeta => ({ ...rows[0]!, id, archivedAt: null, lastTurnAt: ms });
    const set = [s("a", new Date(2026, 9, 5, 23, 59).getTime()), s("b", new Date(2026, 9, 6, 0, 0).getTime()), s("c", new Date(2026, 9, 6, 23, 59).getTime()), s("d", new Date(2026, 9, 7, 0, 0).getTime())];
    assert.deepEqual(applyFilters(set, { ...NO_FILTERS, from: "2026-10-06", to: "2026-10-06" }).map((x) => x.id), ["b", "c"]);
    assert.deepEqual(applyFilters(set, { ...NO_FILTERS, from: "2026-10-07" }).map((x) => x.id), ["d"]);
    assert.equal(activityOf({ ...rows[9]!, lastTurnAt: null }), rows[9]!.createdAt);
  });
  test("filtersActive", () => {
    assert.equal(filtersActive(NO_FILTERS), false);
    assert.equal(filtersActive({ ...NO_FILTERS, text: " " }), false);
    assert.equal(filtersActive({ ...NO_FILTERS, status: "all" }), true);
  });
});

describe("sessions: sort and paging", () => {
  test("sorts by each key in both directions, ties by id", () => {
    assert.equal(sortSessions(rows, "turns", "desc")[0]!.id, "ses_029");
    assert.equal(sortSessions(rows, "created", "asc")[0]!.id, "ses_001");
    assert.equal(sortSessions(rows, "title", "desc")[0]!.title, "Chat 030");
    const act = sortSessions(rows, "activity", "desc");
    assert.ok(activityOf(act[0]!) >= activityOf(act[1]!));
  });
  test("paginate clamps the page and reports the range", () => {
    const p = paginate(rows, 2, 20);
    assert.deepEqual([p.page, p.pages, p.from, p.to, p.total, p.items.length], [2, 2, 21, 30, 30, 10]);
    assert.equal(paginate(rows, 99, 20).page, 2);
    assert.equal(paginate(rows, -3, 20).page, 1);
    assert.deepEqual([paginate([], 1).from, paginate([], 1).to, paginate([], 1).pages], [0, 0, 1]);
  });
  test("metaOf keeps metadata only: a stray preview or message field is dropped", () => {
    const m = metaOf({ ...rows[0]!, preview: "secret text", messages: [{ text: "x" }] } as unknown as SessionMeta);
    assert.equal(JSON.stringify(m).includes("secret"), false);
    assert.deepEqual(Object.keys(m).sort(), ["agentId", "archivedAt", "createdAt", "id", "kind", "lastTurnAt", "model", "pinned", "title", "turnCount", "updatedAt"]);
    const o = metaOf({ ...rows[0]!, owner: "u1", usage: { inputTokens: 1, outputTokens: 2, costMicros: null } } as SessionMeta);
    assert.deepEqual([o.owner, o.usage], ["u1", { inputTokens: 1, outputTokens: 2, costMicros: null }]);
  });
});
