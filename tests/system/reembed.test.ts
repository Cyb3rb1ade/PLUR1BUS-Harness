import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REAL, cli, coreChild, home, reapHome, startCore, startDaemon, stopCore, waitFor, type RunningCore } from "./helpers.ts";

const E5 = "intfloat/multilingual-e5-small"; // the harness default: already the store's identity
const JINA = "jinaai/jina-embeddings-v3";
const GEMMA = "google/embeddinggemma-2"; // pinned, Apache-2.0: no licence question

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

  it("--run needs --yes outside a terminal; without a supervisor the run is copied and validated but cannot switch; --status and --abort agree", { skip: REAL && "flat embedder only" }, async () => {
    const h = home();
    let core: RunningCore | undefined;
    try {
      core = await startCore(h);
      cli(h, ["memory", "reembed", "--plan", "--model", JINA, "--throttle-ms", "0"]);

      const asked = cli(h, ["memory", "reembed", "--run"], { allowFail: true });
      assert.equal(asked.exit, 2, JSON.stringify(asked));
      assert.equal(cli(h, ["memory", "reembed", "--status"]).checkpoint.phase, "planned", "nothing started without the yes");

      const run = cli(h, ["memory", "reembed", "--run", "--yes"], { allowFail: true });
      assert.equal(run.exit, 1, JSON.stringify(run)); // `core run` has no supervisor to write config.json: not a success
      const done = JSON.parse(run.stdout);
      assert.equal(done.schema, "memory.reembed.run/1");
      assert.equal(done.checkpoint.phase, "ready-to-switch", run.stdout);
      assert.equal(done.checkpoint.error.code, "switch-unavailable");
      assert.equal(done.engineState, "ready_to_switch");

      const status = cli(h, ["memory", "reembed", "--status"]);
      assert.equal(status.schema, "memory.reembed.status/1"); assert.equal(status.checkpoint.phase, "ready-to-switch"); assert.equal(status.running, false);

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

// The acceptance of docs/superpowers/plans/2026-10-25-reembed-validate.md: a store with data moves to another pinned local
// model with one `config set`, in the foreground and with --background, through the supervisor (which owns config.json and
// restarts the core on the new generation). The flat seams give every model's vectors their own width, so the restarted
// core reads the 768-dimension generation; nothing is downloaded.
describe("re-embedding a store with data through config set (engine 1.17.0 validate)", { skip: (REAL && "flat embedder only") || (process.platform === "win32" && "daemon lifecycle covered on POSIX") }, () => {
  const FACTS = ["Please remember that the boiler service is on Tuesday.", "Please remember that the harbour tour starts at noon on Saturday."];
  const readyCore = (h: string, what: string, pred: (c: any) => boolean = () => true) =>
    waitFor(what, () => { const c = coreChild(h); return c?.process?.state === "ready" && pred(c) && c; }, 60_000);
  const recalls = (h: string, query: string, fact: string) => {
    const r = cli(h, ["memory", "recall", "--agent", "bernd", query]);
    assert.equal(r.degraded, null, JSON.stringify(r));
    assert.ok(r.blocks.some((b: any) => String(b.text).includes(fact)), `recall finds "${fact}": ${JSON.stringify(r.blocks)}`);
  };
  const generations = (h: string): string[] => { const dir = join(h, "state", "lancedb", "generations"); return existsSync(dir) ? readdirSync(dir) : []; };
  const embeddingOf = (h: string) => JSON.parse(readFileSync(join(h, "config.json"), "utf8")).engine ?? {};

  async function withStore(run: (h: string, before: any) => Promise<void>) {
    const h = home();
    try {
      cli(h, ["agent", "create", "bernd"]);
      cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]); // distinct facts with the flat embedder
      startDaemon(h);
      const before = await readyCore(h, "a ready core");
      for (const f of FACTS) assert.equal(cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", f]).stored, 1);
      recalls(h, "boiler service", FACTS[0]!);
      // A preview and a declined confirmation (no --yes outside a terminal) plan, write nothing and do not block the move.
      const preview = cli(h, ["config", "set", "engine.embedding.local.model", GEMMA, "--dry-run"]);
      assert.equal(preview.schema, "memory.reembed.plan/1", JSON.stringify(preview));
      assert.equal(preview.plan.rows, FACTS.length);
      const declined = cli(h, ["config", "set", "engine.embedding.local.model", GEMMA], { allowFail: true });
      assert.equal(declined.exit, 2, JSON.stringify(declined));
      assert.equal(embeddingOf(h).reembedding, undefined, "nothing written before the move");
      await run(h, before);
    } finally {
      cli(h, ["daemon", "stop"], { allowFail: true });
      await reapHome(h);
      rmSync(h, { recursive: true, force: true });
    }
  }

  async function assertSwitched(h: string, before: any) {
    const status = cli(h, ["memory", "reembed", "--status"]);
    assert.equal(status.checkpoint.phase, "switched", JSON.stringify(status));
    assert.equal(status.checkpoint.error, null);
    const engine = embeddingOf(h);
    assert.equal(engine.embedding?.local?.model, GEMMA, JSON.stringify(engine));
    assert.equal(engine.reembedding?.activeGeneration, status.checkpoint.targetGeneration, JSON.stringify(engine));
    // The core restarted on the new generation; the old one stays on disk beside it (rollback, docs/embedding-migration.md).
    await readyCore(h, "the core restarted on the new generation", (c) => c.pid !== before.pid);
    assert.ok(generations(h).includes(status.checkpoint.targetGeneration), JSON.stringify(generations(h)));
    assert.ok(readdirSync(join(h, "state", "lancedb", "bernd")).length > 0, "the source generation (the agent's table in the store root) is kept");
    for (const [i, q] of ["boiler service", "harbour tour"].entries()) recalls(h, q, FACTS[i]!);
  }

  it("foreground: config set plans, copies, validates and switches; recall answers from the new generation", async () => {
    await withStore(async (h, before) => {
      const moved = cli(h, ["config", "set", "engine.embedding.local.model", GEMMA, "--yes"]);
      assert.equal(moved.schema, "memory.reembed.run/1", JSON.stringify(moved));
      assert.equal(moved.checkpoint.phase, "switched", JSON.stringify(moved));
      await assertSwitched(h, before);
    });
  });

  it("--background: config set returns at once, the core finishes and switches by itself", async () => {
    await withStore(async (h, before) => {
      const started = cli(h, ["config", "set", "engine.embedding.local.model", GEMMA, "--yes", "--background"]);
      assert.equal(started.schema, "memory.reembed.run/1", JSON.stringify(started));
      assert.notEqual(started.checkpoint.phase, "failed", JSON.stringify(started));
      await waitFor("the background run to switch", () => {
        const r = cli(h, ["memory", "reembed", "--status"], { allowFail: true });
        if ("exit" in r) return false; // the core restarts after the switch
        assert.ok(!["failed", "aborted"].includes(r.checkpoint?.phase), JSON.stringify(r));
        return r.checkpoint?.phase === "switched" && r;
      }, 60_000, 250);
      await assertSwitched(h, before);
    });
  });
});
