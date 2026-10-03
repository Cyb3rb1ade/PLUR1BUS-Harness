import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPlatformCapabilities } from "../src/platform.ts";
import { createSystemJobs, type SystemJobHandler } from "../src/system-jobs/index.ts";
import { createModelsScanJob } from "../src/discovery/job.ts";
import { buildMethods } from "../src/rpc/methods.ts";
import { RpcError } from "../src/rpc/errors.ts";
import { tempDir } from "./helpers/temp-dir.ts";
import { FakeClock } from "../src/discovery/testing.ts";

describe("system jobs and jobs.* merge", () => {
  const win = process.platform === "win32";
  const platform = createPlatformCapabilities({ platform: process.platform });

  function createFakeEngine() {
    const agentJobs = [{ name: "consolidate", needsLlm: true, singleton: true, phase: "deep" as const }];
    const agentRuns = [
      {
        runId: "run-agent-1",
        job: "consolidate",
        agentId: "bernd",
        trigger: "manual" as const,
        startedAt: 1758700000000,
        finishedAt: 1758700001000,
        durationMs: 1000,
        outcome: "completed" as const,
        attempt: 1 as const,
      },
    ];

    return {
      jobs: {
        list: () => [...agentJobs],
        run: async (name: string, agentId: string, opts: any) => ({
          runId: "run-agent-2",
          job: name,
          agentId,
          trigger: opts?.trigger ?? "harness",
          startedAt: 1758700002000,
          finishedAt: 1758700003000,
          durationMs: 1000,
          outcome: "completed" as const,
          attempt: 1 as const,
        }),
        history: async (agentId: string, opts: any) =>
          agentRuns.filter((r) => r.agentId === agentId && (!opts?.job || r.job === opts.job)),
      },
    };
  }

  function setup(options?: { engineJobNames?: string[] }) {
    const dir = tempDir("p1b-sys-jobs-");
    const ledgerPath = join(dir, "ledger.jsonl");
    const clock = new FakeClock(1758700000000);
    const engine = createFakeEngine();
    const warnings: string[] = [];
    const logger = {
      warn: (m: string) => {
        warnings.push(m);
      },
      debug: () => {},
      info: () => {},
    };

    const engineHasJob = (name: string) =>
      options?.engineJobNames?.includes(name) ?? engine.jobs.list().some((j) => j.name === name);

    const systemJobs = createSystemJobs({
      ledgerPath,
      clock,
      securePath: platform.securePath,
      logger,
      engineHasJob,
    });

    const notifications: Array<{ name: string; params: unknown }> = [];
    const notifySpy = (name: string, params: unknown) => {
      notifications.push({ name, params });
    };

    const agents = {
      has: (id: string) => id === "bernd",
      workspaceOf: (id: string) => (id === "bernd" ? "/ws/bernd" : undefined),
      get: (id: string) => (id === "bernd" ? { workspace: "/ws/bernd" } : undefined),
    } as any;

    const activity = {
      set: () => {},
      idle: () => {},
      get: () => ({ state: "idle", since: clock.now() }),
    } as any;

    const methods = buildMethods({
      engine: engine as any,
      config: () => ({ core: { recall: { hardBudgetMs: 600, softBudgetMs: 400, capChars: 17000 } } }) as any,
      agents,
      activity,
      logger: logger as any,
      status: () => ({} as any),
      shutdown: () => {},
      journalBacklog: () => 0,
      clock: () => clock.now(),
      captureSignal: new AbortController().signal,
      isStopping: () => false,
      adopt: () => ({} as any),
      onMigrated: () => {},
      systemJobs,
    });

    // Mock call helper simulating RPC dispatch
    async function call(method: string, params: unknown) {
      const handler = methods[method];
      if (!handler) throw new RpcError("E_INTERNAL", `method-not-found: ${method}`, { reason: "method-not-found" });
      return await handler(params as any, {
        signal: new AbortController().signal,
        connectionId: "conn-1",
        requestId: "req-1",
      });
    }

    return {
      dir,
      ledgerPath,
      clock,
      engine,
      systemJobs,
      methods,
      call,
      notifications,
      notifySpy,
      warnings,
    };
  }

  function createMockDiscoveryService(profilesList: string[] = ["example-compat"]) {
    return {
      scanProvider: async () => {
        throw new Error("not implemented");
      },
      scanAll: async (r: any, only?: string) => {
        return [
          {
            provider: only ?? "example-compat",
            result: "ok" as const,
            new: ["example-chat-large"],
            reappeared: [],
            unavailable: [],
            unchanged: 0,
            duplicates: 0,
            warnings: [],
            nextScanAt: null,
          },
        ];
      },
      list: () => ({} as any),
      setOverride: async () => ({} as any),
      removeManual: async () => ({ removed: true as const }),
      acknowledge: async () => ({ acknowledgedAt: "now" }),
      onChanged: () => () => {},
      nextRunAt: () => null,
      scannable: () => profilesList.map((id) => ({ id, name: id, vendor: "generic", discovery: "openai-models" as const })),
      hasProfile: (id: string) => profilesList.includes(id),
    };
  }

  it("jobs.list default output is byte-identical to the engine's", async () => {
    const { call, engine, systemJobs } = setup();
    const svc = createMockDiscoveryService();
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 })));

    const result = await call("jobs.list", {});
    assert.equal(JSON.stringify(result), JSON.stringify({ jobs: engine.jobs.list() }));
  });

  it("kind system and all show models.scan", async () => {
    const { call, engine, systemJobs } = setup();
    const svc = createMockDiscoveryService();
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 })));

    const sysRes = (await call("jobs.list", { kind: "system" })) as any;
    assert.deepEqual(sysRes.jobs, [
      {
        name: "models.scan",
        kind: "system",
        needsLlm: false,
        singleton: true,
        schedule: { every: 86400000, jitter: 0.1 },
        nextRunAt: null,
      },
    ]);

    const allRes = (await call("jobs.list", { kind: "all" })) as any;
    assert.deepEqual(allRes.jobs, [
      ...engine.jobs.list(),
      {
        name: "models.scan",
        kind: "system",
        needsLlm: false,
        singleton: true,
        schedule: { every: 86400000, jitter: 0.1 },
        nextRunAt: null,
      },
    ]);
  });

  it("jobs.history without agentId is the system runs, with agentId only that agent's", async () => {
    const { call, systemJobs, ledgerPath } = setup();
    const svc = createMockDiscoveryService();
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 })));

    // Run system job once
    await call("jobs.run", { job: "models.scan" });

    // history without agentId -> system runs
    const sysHist = (await call("jobs.history", {})) as any;
    assert.equal(sysHist.runs.length, 1);
    assert.equal(sysHist.runs[0].kind, "system");
    assert.equal(sysHist.runs[0].job, "models.scan");
    assert.equal("agentId" in sysHist.runs[0], false);

    // history with agentId -> agent runs
    const agentHist = (await call("jobs.history", { agentId: "bernd" })) as any;
    assert.equal(agentHist.runs.length, 1);
    assert.equal(agentHist.runs[0].job, "consolidate");
    assert.equal(agentHist.runs[0].agentId, "bernd");

    // history with agentId and job naming a system job -> []
    const emptyHist = (await call("jobs.history", { agentId: "bernd", job: "models.scan" })) as any;
    assert.deepEqual(emptyHist.runs, []);
  });

  it("jobs.run on a system job without agentId works", async () => {
    const { call, systemJobs } = setup();
    const svc = createMockDiscoveryService();
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 })));

    const result = (await call("jobs.run", { job: "models.scan" })) as any;
    assert.equal(result.kind, "system");
    assert.equal(result.job, "models.scan");
    assert.equal(result.outcome, "completed");
    assert.equal("agentId" in result, false);
  });

  it("jobs.run: agentId on a system job and no agentId on an agent job are refused", async () => {
    const { call, systemJobs } = setup();
    const svc = createMockDiscoveryService();
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 })));

    // AgentId on system job
    await assert.rejects(
      call("jobs.run", { job: "models.scan", agentId: "bernd" }),
      (err: any) => err instanceof RpcError && err.error === "E_INVALID_PARAMS" && err.detail === "agentId",
    );

    // No agentId on agent job
    await assert.rejects(
      call("jobs.run", { job: "consolidate" }),
      (err: any) => err instanceof RpcError && err.error === "E_INVALID_PARAMS" && err.detail === "agentId",
    );
  });

  it("jobs.run args are closed", async () => {
    const { call, systemJobs } = setup();
    const svc = createMockDiscoveryService(["valid-provider"]);
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 })));

    // Unknown arg { x: 1 }
    await assert.rejects(
      call("jobs.run", { job: "models.scan", args: { x: 1 } }),
      (err: any) => err instanceof RpcError && err.error === "E_INVALID_PARAMS",
    );

    // Unknown provider { provider: "nope" }
    await assert.rejects(
      call("jobs.run", { job: "models.scan", args: { provider: "nope" } }),
      (err: any) => err instanceof RpcError && err.error === "E_INVALID_PARAMS" && err.reason === "unknown-provider",
    );
  });

  it("every run, skips included, writes started and finished rows before returning", async () => {
    const { call, systemJobs, ledgerPath } = setup();

    // 1. disabled
    let svcState: "disabled" | "already_running" | "no-scanner" = "disabled";
    const svc = {
      ...createMockDiscoveryService(["p1"]),
      scanAll: async () => [{
        provider: "p1",
        result: svcState,
        runningRunId: svcState === "already_running" ? "run-original-1" : undefined,
        new: [],
        reappeared: [],
        unavailable: [],
        unchanged: 0,
        duplicates: 0,
        warnings: [],
        nextScanAt: null,
      }],
    };
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: false, intervalHours: 24 })));

    // Disabled run
    const disabledRun = (await call("jobs.run", { job: "models.scan" })) as any;
    assert.equal(disabledRun.outcome, "skipped");
    assert.equal(disabledRun.reason, "disabled");

    // Already running
    svcState = "already_running";
    const runningRun = (await call("jobs.run", { job: "models.scan" })) as any;
    assert.equal(runningRun.outcome, "skipped");
    assert.equal(runningRun.reason, "already_running");
    assert.equal(runningRun.runningRunId, "run-original-1");

    // No scanner
    svcState = "no-scanner";
    const noScannerRun = (await call("jobs.run", { job: "models.scan" })) as any;
    assert.equal(noScannerRun.outcome, "skipped");
    assert.equal(noScannerRun.reason, "no-scanner");

    // Check ledger rows
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 6); // 2 per request: started and finished
    assert.equal(lines[0].phase, "started");
    assert.equal(lines[1].phase, "finished");
    assert.equal(lines[1].outcome, "skipped");
    assert.equal(lines[1].reason, "disabled");
    assert.equal(lines[3].outcome, "skipped");
    assert.equal(lines[3].reason, "already_running");
    assert.equal(lines[5].outcome, "skipped");
    assert.equal(lines[5].reason, "no-scanner");
  });

  it("a throwing handler still leaves a failed row", async () => {
    const { systemJobs, ledgerPath } = setup();

    const throwingHandler: SystemJobHandler = {
      spec: {
        name: "test.fail",
        needsLlm: false,
        singleton: true,
        schedule: { every: 1000, jitter: 0 },
      },
      nextRunAt: () => null,
      validateArgs: () => ({}),
      run: async () => {
        throw new Error("SECRET_MESSAGE_SHOULD_NOT_LEAK");
      },
    };
    systemJobs.register(throwingHandler);

    await assert.rejects(systemJobs.run("test.fail", {}, { trigger: "manual" }));

    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].phase, "started");
    assert.equal(lines[1].phase, "finished");
    assert.equal(lines[1].outcome, "failed");
    assert.equal(lines[1].reason, "exception");
    assert.equal(JSON.stringify(lines).includes("SECRET_MESSAGE_SHOULD_NOT_LEAK"), false);
  });

  it("a started row without a finished row reads back as abandoned", async () => {
    const { systemJobs, ledgerPath } = setup();

    // Manually write an unclosed started row
    const row = {
      v: 1,
      runId: "run-orphaned-1",
      phase: "started",
      job: "test.orphaned",
      trigger: "cron",
      startedAt: 1758700010000,
    };
    writeFileSync(ledgerPath, JSON.stringify(row) + "\n");

    const hist = systemJobs.history({});
    assert.equal(hist.length, 1);
    assert.ok(hist[0]);
    assert.equal(hist[0].runId, "run-orphaned-1");
    assert.equal(hist[0].outcome, "abandoned");
    assert.equal(hist[0].reason, "core_stopped");
  });

  it("a corrupt ledger line is skipped", async () => {
    const { systemJobs, ledgerPath, warnings } = setup();

    writeFileSync(ledgerPath, "NOT_JSON\n" + JSON.stringify({
      v: 1,
      runId: "run-valid",
      phase: "finished",
      job: "test.valid",
      trigger: "manual",
      startedAt: 1000,
      finishedAt: 2000,
      durationMs: 1000,
      outcome: "completed",
      attempt: 1,
    }) + "\n");

    const hist = systemJobs.history({});
    assert.equal(hist.length, 1);
    assert.ok(hist[0]);
    assert.equal(hist[0].runId, "run-valid");
    assert.ok(warnings.length > 0);
  });

  it("the ledger is 0600", { skip: win }, async () => {
    const { systemJobs, ledgerPath } = setup();
    const svc = createMockDiscoveryService();
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 })));

    await systemJobs.run("models.scan", {}, { trigger: "manual" });
    const mode = statSync(ledgerPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("an engine job named models.scan is refused at registration", () => {
    const { systemJobs } = setup({ engineJobNames: ["models.scan"] });
    const svc = createMockDiscoveryService();
    assert.throws(
      () => systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 }))),
      /conflict|already exists|refused/i,
    );
  });

  it("system runs emit no job.run notification", async () => {
    const { call, systemJobs, notifications } = setup();
    const svc = createMockDiscoveryService();
    systemJobs.register(createModelsScanJob(svc as any, () => ({ enabled: true, intervalHours: 24 })));

    await call("jobs.run", { job: "models.scan" });
    const jobRunNotifications = notifications.filter((n) => n.name === "job.run");
    assert.equal(jobRunNotifications.length, 0);
  });
});
