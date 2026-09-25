import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REAL, cli, home, killCore, startCore, stopCore, type RunningCore } from "./helpers.ts";

/** R20: a fully successful replay renames `<agent>.jsonl` away and appends nothing back — absent or empty. */
function journalDrained(path: string): boolean {
  return !existsSync(path) || readFileSync(path, "utf8").trim() === "";
}

describe("M1 acceptance 1 — two-session recall through the CLI", () => {
  it("captures in s1, recalls in s2 (reranker ran with real models); survives a core kill via the journal", async (t) => {
    const h = home();
    const journal = join(h, "state/journal/bernd.jsonl");
    cli(h, ["agent", "create", "bernd"]);
    // The flat embedder gives every text the same vector, so the engine's duplicate check (0.95) would
    // skip every fact after the first; above 1 it never matches. Real models keep the default.
    if (!REAL) cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);

    let core: RunningCore = await startCore(h);
    t.diagnostic(`core ready (1st start) ${core.readyMs.toFixed(0)} ms${REAL ? " [real models]" : " [flat embedder]"}`);
    try {
      const status = cli(h, ["dreams", "status"]);
      assert.equal(status.jobs.length, 18, JSON.stringify(status));

      let t0 = performance.now();
      const add = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", "Please remember that the roadmap review is on Thursday at ten."]);
      t.diagnostic(`CLI memory add ${(performance.now() - t0).toFixed(0)} ms: ${JSON.stringify(add)}`);
      assert.ok(add.stored >= 1, JSON.stringify(add));
      // A second, unrelated fact: the engine only calls the reranker with more than one candidate.
      const other = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", "Please remember that the quarterly budget draft is due in March."]);
      assert.ok(other.stored >= 1, JSON.stringify(other));

      t0 = performance.now();
      const r = cli(h, ["memory", "recall", "--agent", "bernd", "--session", "s2", "--joined", "when is the roadmap review"]);
      const ms = performance.now() - t0;
      t.diagnostic(`CLI memory recall ${ms.toFixed(0)} ms; timing ${JSON.stringify(r.timing ?? null)}`);
      assert.equal(r.degraded, null, JSON.stringify(r.degraded));
      assert.match(r.joined.text, /roadmap review/i);
      if (REAL) {
        // The engine's per-namespace phase list (timing.namespacePhases) records a "rerank" phase on every
        // recall, even with no reranker; only a real cross-encoder makes it take measurable time.
        const rerank = (r.timing?.namespacePhases ?? []).filter((p: any) => p.phase === "rerank");
        assert.ok(rerank.length > 0 && rerank.some((p: any) => p.ms > 0), `reranker ran: ${JSON.stringify(r.timing)}`);
      }
      assert.ok(ms < 5000, `CLI recall took ${ms} ms`);

      // §8 "core killed mid-use": degraded fast, add journaled, replayed after restart.
      await killCore(core, "SIGKILL");
      const t1 = performance.now();
      const down = cli(h, ["memory", "recall", "--agent", "bernd", "anything"]);
      const downMs = performance.now() - t1;
      t.diagnostic(`CLI recall with the core down ${downMs.toFixed(0)} ms: ${JSON.stringify(down.degraded)}`);
      assert.equal(down.degraded?.reason, "core-unavailable", JSON.stringify(down));
      assert.ok(downMs < 1000, `degraded recall took ${downMs} ms`);

      const j = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s3", "Also remember that Mira visits every spring."]);
      assert.equal(j.journaled, true, JSON.stringify(j));
      assert.ok(existsSync(journal), "journal written while the core is down");
      assert.match(readFileSync(journal, "utf8"), /Mira visits every spring/);

      core = await startCore(h); // replay runs during start, before the ready line
      t.diagnostic(`core ready (restart with replay) ${core.readyMs.toFixed(0)} ms; journal after replay: ${existsSync(journal) ? "present" : "absent"}`);
      assert.ok(journalDrained(journal), `journal drained: ${existsSync(journal) ? readFileSync(journal, "utf8") : "(absent)"}`);

      const after = cli(h, ["memory", "recall", "--agent", "bernd", "--session", "s4", "--joined", "when does Mira visit"]);
      assert.equal(after.degraded, null, JSON.stringify(after.degraded));
      assert.match(after.joined.text, /Mira|spring/i);

      const run = cli(h, ["dreams", "run", "gc-run", "--agent", "bernd"]);
      assert.ok(["completed", "skipped"].includes(run.outcome), JSON.stringify(run));
    } finally {
      await stopCore(core);
    }
  });
});
