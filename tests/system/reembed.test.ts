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
