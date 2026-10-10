// Activity feed model: event -> sentence mapping per event type, day grouping boundaries, merge and the "Open in log" link.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { catalogues, t } from "../src/i18n.ts";
import { classify, groupEntries, groupOf, jobKind, logLink, mergeEntries, sentence, sentenceKey, toEntries } from "../src/pages/logs/activity/model.ts";
import { at, audit, diag, NOW } from "./activity-fixtures.ts";

describe("activity: event to sentence mapping", () => {
  const cases: [string, ReturnType<typeof diag>, string, string, RegExp][] = [
    ["agent run completed", diag(at(7, 8), "scheduler.run.completed", "cron.report", "main"), "agentRun", "completed", /Agent main finished the job cron\.report\./],
    ["agent run failed", diag(at(7, 8), "scheduler.run.failed", "cron.report", "main"), "agentRun", "failed", /The job cron\.report of agent main failed\./],
    ["agent run skipped", diag(at(7, 8), "scheduler.run.skipped", "cron.report", "main"), "agentRun", "skipped", /Agent main skipped the job cron\.report\./],
    ["dreams", diag(at(7, 8), "scheduler.run.completed", "dreams.light", "main"), "dreams", "completed", /Dreaming \(dreams\.light\) finished for agent main\./],
    ["dreams (consolidate)", diag(at(7, 8), "scheduler.run.failed", "consolidate-daily", "main"), "dreams", "failed", /Dreaming \(consolidate-daily\) failed for agent main\./],
    ["model scan", diag(at(7, 8), "scheduler.run.completed", "models.scan", ""), "modelScan", "completed", /^The model scan finished\.$/],
    ["backup", diag(at(7, 8), "scheduler.run.failed", "backup.daily", ""), "backup", "failed", /^A backup failed\.$/],
    ["backup skipped", diag(at(7, 8), "scheduler.run.skipped", "backup.daily", ""), "backup", "skipped", /^A backup was skipped\.$/],
    ["login", audit(at(7, 8), "auth.login", { profile: "default" }), "login", "none", /^Signed in with the profile default\.$/],
    ["logout", audit(at(7, 8), "auth.logout", { profile: "default" }), "logout", "none", /^Signed out of the profile default\.$/],
    ["break-glass", audit(at(7, 8), "user.break_glass", { target: "usr_anna", reason: "r" }), "breakGlass", "none", /^Break-glass access to usr_anna\.$/],
  ];
  for (const [name, rec, kind, outcome, re] of cases) {
    test(name, () => {
      const e = classify(rec);
      assert.ok(e, "classified");
      assert.equal(e.kind, kind);
      assert.equal(e.outcome, outcome);
      assert.match(sentence(e), re);
      assert.ok(sentenceKey(e) in catalogues.en, `${sentenceKey(e)} exists in en`);
      assert.ok(sentenceKey(e) in catalogues.de, `${sentenceKey(e)} exists in de`);
    });
  }

  test("records the feed does not summarise are dropped", () => {
    assert.equal(classify(audit(at(7, 8), "config.set", { key: "x" })), null);
    assert.equal(classify(diag(at(7, 8), "scheduler.run.started", "cron.report")), null);
    assert.equal(classify(diag(at(7, 8), "scheduler.run.completed", "cron.report", "")), null, "a system job that is none of the four kinds");
    assert.equal(classify({ ...diag(at(7, 8), "x", "y"), ts: "not a date" }), null);
  });

  test("a missing parameter reads 'unknown', never 'undefined'", () => {
    const e = classify(diag(at(7, 8), "scheduler.run.completed", "", "main"))!;
    assert.equal(sentence(e), "Agent main finished the job unknown.");
  });

  test("sentence keys take their placeholders", () => {
    const e = classify(diag(at(7, 8), "scheduler.run.completed", "dreams.light", "main"))!;
    assert.equal(t(sentenceKey(e) as never, { agent: "main", job: "dreams.light" }), "Dreaming (dreams.light) finished for agent main.");
  });

  test("jobKind", () => {
    assert.equal(jobKind("dreams.rem", false), "dreams");
    assert.equal(jobKind("rem-dream", true), "dreams");
    assert.equal(jobKind("models.scan", false), "modelScan");
    assert.equal(jobKind("backup", false), "backup");
    assert.equal(jobKind("cron.x", true), "agentRun");
    assert.equal(jobKind("cron.x", false), null);
  });

  test("actor: the audit user, else the principal or agent; system when none", () => {
    assert.equal(classify(audit(at(7, 8), "auth.login", { profile: "p" }, "usr_owner"))!.actor, "usr_owner");
    assert.equal(classify(diag(at(7, 8), "scheduler.run.completed", "cron.x", "bernd"))!.actor, "bernd");
    assert.equal(classify(diag(at(7, 8), "scheduler.run.completed", "models.scan", ""))!.actor, "");
  });
});

describe("activity: grouping by day (fixed clock: Wed 7 Oct 2026, 12:00)", () => {
  test("boundaries", () => {
    assert.equal(groupOf(NOW, NOW), "today");
    assert.equal(groupOf(at(7, 0, 0), NOW), "today", "midnight starts today");
    assert.equal(groupOf(at(6, 23, 59), NOW), "yesterday", "one minute before midnight");
    assert.equal(groupOf(at(6, 0, 0), NOW), "yesterday");
    assert.equal(groupOf(at(5, 23, 59), NOW), "week", "Tuesday... Monday evening is earlier this week");
    assert.equal(groupOf(at(5, 0, 0), NOW), "week", "Monday 00:00 is the start of the week");
    assert.equal(groupOf(at(4, 23, 59), NOW), "older", "Sunday before");
    assert.equal(groupOf(at(7, 18), NOW), "today", "a future time (clock skew) counts as today");
  });

  test("on a Monday yesterday is Sunday and there is no 'earlier this week'", () => {
    const monday = new Date(2026, 9, 5, 12).getTime();
    assert.equal(groupOf(new Date(2026, 9, 4, 20).getTime(), monday), "yesterday");
    assert.equal(groupOf(new Date(2026, 9, 3, 20).getTime(), monday), "older");
  });

  test("groups come in heading order, empty ones are left out, newest first inside", () => {
    const entries = toEntries([diag(at(1, 8), "scheduler.run.completed", "cron.a", "main"), diag(at(7, 8), "scheduler.run.completed", "cron.b", "main"), diag(at(7, 9), "scheduler.run.completed", "cron.c", "main"), diag(at(5, 8), "scheduler.run.completed", "cron.d", "main")]);
    const groups = groupEntries(entries, NOW);
    assert.deepEqual(groups.map((g) => g.id), ["today", "week", "older"]);
    assert.deepEqual(groups[0]!.entries.map((e) => e.params.job), ["cron.c", "cron.b"]);
  });
});

describe("activity: merge and link", () => {
  test("mergeEntries drops duplicates and keeps newest first", () => {
    const a = toEntries([diag(at(7, 8), "scheduler.run.completed", "cron.a", "main", "x")]);
    const b = toEntries([diag(at(7, 8), "scheduler.run.completed", "cron.a", "main", "x"), diag(at(7, 9), "scheduler.run.completed", "cron.b", "main", "y")]);
    assert.deepEqual(mergeEntries(a, b).map((e) => e.params.job), ["cron.b", "cron.a"]);
  });

  test("the log link searches for the trace id, else the job or target, and names the stream", () => {
    assert.equal(logLink(classify(diag(at(7, 8), "scheduler.run.completed", "cron.a", "main", "0af7651916cd43dd8448eb211c80319c"))!), "#/logs?q=0af7651916cd43dd8448eb211c80319c&stream=diagnostic");
    assert.equal(logLink(classify(diag(at(7, 8), "scheduler.run.completed", "cron.a", "main"))!), "#/logs?q=cron.a&stream=diagnostic");
    assert.equal(logLink(classify(audit(at(7, 8), "user.break_glass", { target: "usr anna&x" }))!), "#/logs?q=usr%20anna%26x&stream=audit");
  });
});
