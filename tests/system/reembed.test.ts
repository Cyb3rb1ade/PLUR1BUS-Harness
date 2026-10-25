import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REAL, cli, home, startCore, stopCore, type RunningCore } from "./helpers.ts";

const E5 = "intfloat/multilingual-e5-small"; // the harness default: already the store's identity
const JINA = "jinaai/jina-embeddings-v3";

// CLI → core → the pinned engine's re-embedding coordinator, no model download (flat embedder; an empty store).
describe("M2 — memory reembed through the CLI (acceptance 6)", () => {
  it("--plan: the default model is compatible; another pinned model needs migration; an unpinned one is refused with its reason", { skip: REAL && "flat embedder only" }, async () => {
    const h = home();
    let core: RunningCore | undefined;
    try {
      core = await startCore(h);
      const same = cli(h, ["memory", "reembed", "--plan", "--model", E5]);
      assert.equal(same.schema, "memory.reembed.plan/1");
      assert.equal(same.probe.verdict, "compatible", JSON.stringify(same)); assert.equal(same.plan, null);

      const refused = cli(h, ["memory", "reembed", "--plan", "--model", "someone/unpinned"], { allowFail: true });
      assert.equal(refused.exit, 1, JSON.stringify(refused));
      const doc = JSON.parse(refused.stdout);
      assert.equal(doc.probe.verdict, "incompatible"); assert.deepEqual(doc.probe.reasons, ["target-model-unpinned"]);

      const plan = cli(h, ["memory", "reembed", "--plan", "--model", JINA, "--throttle-ms", "0"]);
      assert.equal(plan.probe.verdict, "migration-needed", JSON.stringify(plan));
      assert.ok(plan.probe.changed.includes("model"));
      assert.equal(plan.plan.throttleMs, 0); assert.equal(plan.plan.batchSize, 8);
      assert.ok(!JSON.stringify(plan).includes("reemb_v1_"), "the confirmation token never reaches the CLI");
      assert.ok(existsSync(join(h, "state", "reembed", "migration.json")));
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("--run needs --yes outside a terminal; with it the run is followed and stops fail-closed at validating; --status and --abort agree", { skip: REAL && "flat embedder only" }, async () => {
    const h = home();
    let core: RunningCore | undefined;
    try {
      core = await startCore(h);
      cli(h, ["memory", "reembed", "--plan", "--model", JINA, "--throttle-ms", "0"]);

      const asked = cli(h, ["memory", "reembed", "--run"], { allowFail: true });
      assert.equal(asked.exit, 2, JSON.stringify(asked));
      assert.equal(cli(h, ["memory", "reembed", "--status"]).checkpoint.phase, "planned", "nothing started without the yes");

      const run = cli(h, ["memory", "reembed", "--run", "--yes"], { allowFail: true });
      assert.equal(run.exit, 1, JSON.stringify(run)); // the pinned engine cannot validate: not a success
      const done = JSON.parse(run.stdout);
      assert.equal(done.schema, "memory.reembed.run/1");
      assert.equal(done.checkpoint.phase, "validating", run.stdout);
      assert.equal(done.checkpoint.error.code, "engine-validate-unavailable");
      assert.equal(done.engineState, "validating");

      const status = cli(h, ["memory", "reembed", "--status"]);
      assert.equal(status.schema, "memory.reembed.status/1"); assert.equal(status.checkpoint.phase, "validating"); assert.equal(status.running, false);

      // The active store was never touched: the configuration is unchanged and no selection was written.
      const config = JSON.parse(readFileSync(join(h, "config.json"), "utf8"));
      assert.equal(config.engine?.reembedding, undefined);

      const aborted = cli(h, ["memory", "reembed", "--abort"]);
      assert.equal(aborted.schema, "memory.reembed.abort/1"); assert.equal(aborted.checkpoint.phase, "aborted");
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("a store with data: planning the same model twice reuses the plan and --run continues it; another model is refused with the plan's expiry", { skip: REAL && "flat embedder only" }, async () => {
    const h = home();
    let core: RunningCore | undefined;
    try {
      cli(h, ["agent", "create", "bernd"]);
      cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]); // the flat embedder: two facts are not duplicates
      core = await startCore(h);
      for (const f of ["The offsite is in June.", "Bernd prefers green tea."]) assert.equal(cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", f]).stored, 1);

      // The engine keeps an unconfirmed plan for its confirmation lifetime (1 h) and refuses any other one meanwhile.
      const first = cli(h, ["memory", "reembed", "--plan", "--model", JINA, "--throttle-ms", "0"]);
      assert.equal(first.probe.verdict, "migration-needed", JSON.stringify(first)); assert.ok(first.plan.rows >= 2, JSON.stringify(first.plan));
      const again = cli(h, ["memory", "reembed", "--plan", "--model", JINA, "--throttle-ms", "0"]);
      assert.equal(again.plan.id, first.plan.id, "the unstarted plan is reused, not refused");

      const other = cli(h, ["memory", "reembed", "--plan", "--model", "google/embeddinggemma-2"], { allowFail: true });
      assert.equal(other.exit, 1, JSON.stringify(other));
      const refusal = JSON.parse(other.stdout);
      assert.equal(refusal.error, "E_CONFLICT"); assert.equal(refusal.reason, "migration-active");
      assert.match(refusal.message, /holds the store until \d{4}-\d\d-\d\dT[\d:.]+Z/); assert.match(refusal.message, /--abort/);

      // The run starts the reused plan: the engine accepts its confirmation and leaves `planned`. The flat seam does not embed
      // the target, so the first batch then stops at the model's licence gate (before any download); the copy and the switch
      // are the driver tests' (fake engine), the pinned engine cannot validate anyway.
      const run = cli(h, ["memory", "reembed", "--run", "--yes"], { allowFail: true });
      const done = JSON.parse(run.stdout);
      assert.equal(done.checkpoint.id, first.plan.id, run.stdout);
      assert.equal(done.engineState, "running", run.stdout);
      assert.equal(cli(h, ["memory", "reembed", "--abort"]).checkpoint.id, first.plan.id);
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("--status with nothing planned, and --run/--abort without a plan, are plain refusals", { skip: REAL && "flat embedder only" }, async () => {
    const h = home();
    let core: RunningCore | undefined;
    try {
      core = await startCore(h);
      assert.equal(cli(h, ["memory", "reembed", "--status"]).checkpoint, null);
      const run = cli(h, ["memory", "reembed", "--run", "--yes"], { allowFail: true });
      assert.equal(run.exit, 1); assert.equal(JSON.parse(run.stdout).reason, "no-migration");
      const abort = cli(h, ["memory", "reembed", "--abort"], { allowFail: true });
      assert.equal(abort.exit, 1); assert.equal(JSON.parse(abort.stdout).error, "E_NOT_FOUND");
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });
});
