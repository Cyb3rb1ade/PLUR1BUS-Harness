import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { REAL, SHARED_MEMORY, cli, home, startCore, stopCore, type RunningCore } from "./helpers.ts";

/** Every CLI call in this test must answer within this wall time. */
const CLI_BUDGET_MS = 2000;

describe("M1b-2a-H2 — memory surface through the CLI", () => {
  it("memory surface end to end through the CLI", { skip: REAL && "flat embedder only" }, async (t) => {
    const h = home();
    let core: RunningCore | undefined;
    /** `cli()` with a wall-time assertion; a failing call (allowFail) is parsed as its `--json` error document. */
    const run = (args: string[], opts: { allowFail?: boolean } = {}): any => {
      const t0 = performance.now();
      const out = cli(h, args, opts);
      const ms = performance.now() - t0;
      assert.ok(ms < CLI_BUDGET_MS, `${args.join(" ")} took ${ms.toFixed(0)} ms`);
      if (opts.allowFail && typeof out?.exit === "number") return { exit: out.exit, doc: JSON.parse(out.stdout) };
      return out;
    };
    try {
      run(["agent", "create", "bernd"]);
      run(["agent", "create", "anna"]);
      // The flat embedder gives every text the same vector; above 1 the duplicate check never matches.
      run(["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);

      core = await startCore(h);
      t.diagnostic(`core ready ${core.readyMs.toFixed(0)} ms [flat embedder]`);

      for (const text of [
        "Please remember that the roadmap review is on Thursday at ten.",
        "Please remember that the quarterly budget draft is due in March.",
      ]) {
        const add = run(["memory", "add", "--agent", "bernd", "--session", "s1", text]);
        assert.equal(add.stored, 1, JSON.stringify(add));
      }

      const list = run(["memory", "list", "--agent", "bernd"]);
      assert.equal(list.schema, "memory.list/1");
      assert.equal(list.items.length, 2, JSON.stringify(list));
      const [first, second] = list.items.map((i: any) => i.id as string);

      const show = run(["memory", "show", "--agent", "bernd", first]);
      assert.equal(show.schema, "memory.show/1");
      assert.equal(show.card.id, first, JSON.stringify(show));

      const corrected = run(["memory", "correct", "--agent", "bernd", first, "The roadmap review moved to Friday at ten."]);
      assert.equal(corrected.schema, "memory.correct/1");
      assert.equal(typeof corrected.id, "string");
      assert.notEqual(corrected.id, first, JSON.stringify(corrected));

      const forgot = run(["memory", "forget", "--agent", "bernd", "--yes", second]);
      assert.equal(forgot.schema, "memory.forget/1");
      assert.equal(forgot.id, second, JSON.stringify(forgot));

      const state = run(["memory", "state", "--agent", "bernd"]);
      assert.equal(state.schema, "memory.state/1");
      assert.equal(state.cards.agentPrivate, 1, JSON.stringify(state));

      if (!SHARED_MEMORY) {
        // Engine limitation on macOS/Windows: explicit shared memory is disabled and share fails with storage.
        const refused = run(["memory", "share", "--agent", "bernd", corrected.id, "--to", "user"], { allowFail: true });
        assert.equal(refused.exit, 1, JSON.stringify(refused));
        assert.equal(refused.doc.error, "E_STORAGE", JSON.stringify(refused.doc));
      } else {
        const share = run(["memory", "share", "--agent", "bernd", corrected.id, "--to", "user"]);
        assert.equal(share.schema, "memory.share/1");
        assert.equal(share.sourceId, corrected.id, JSON.stringify(share));

        const annaList = run(["memory", "list", "--agent", "anna"]);
        const copy = annaList.items.find((i: any) => i.sharedBy === "bernd");
        assert.ok(copy, `anna sees bernd's shared card: ${JSON.stringify(annaList)}`);
        assert.equal(copy.id, share.sharedId);

        const proposal = run(["memory", "propose", "--agent", "anna", copy.id, "The roadmap review is on Friday at eleven."]);
        assert.equal(proposal.schema, "memory.propose/1");
        assert.equal(proposal.sharerAgentId, "bernd");

        const pending = run(["memory", "proposals", "list", "--agent", "bernd"]);
        assert.equal(pending.schema, "memory.proposals.list/1");
        assert.equal(pending.items.length, 1, JSON.stringify(pending));
        assert.equal(pending.items[0].status, "pending");
        assert.equal(pending.items[0].id, proposal.proposalId);

        const accepted = run(["memory", "proposals", "accept", "--agent", "bernd", proposal.proposalId]);
        assert.equal(accepted.schema, "memory.proposals.accept/1");
        assert.equal(accepted.proposalId, proposal.proposalId);

        const annaAccepted = run(["memory", "proposals", "list", "--agent", "anna", "--status", "accepted"]);
        assert.equal(annaAccepted.items.length, 1, JSON.stringify(annaAccepted));
        assert.equal(annaAccepted.items[0].id, proposal.proposalId);

        // Accepting refreshes anna's copy under a new id (the accept result's `id`); the old copy id is gone.
        const refreshed = run(["memory", "list", "--agent", "anna"]).items.find((i: any) => i.sharedBy === "bernd");
        assert.equal(refreshed?.id, accepted.id, JSON.stringify(refreshed));
        assert.match(refreshed.text, /Friday at eleven/);

        // Only the sharing agent can retract a shared copy.
        const denied = run(["memory", "forget", "--agent", "anna", "--yes", refreshed.id], { allowFail: true });
        assert.equal(denied.exit, 1, JSON.stringify(denied));
        assert.equal(denied.doc.error, "E_DENIED", JSON.stringify(denied.doc));
        assert.equal(denied.doc.schema, "error/1");
      }
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });
});
