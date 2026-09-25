import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { RPC_VERSION, type CoreStatusResult, type ProcessState } from "@plur1bus/rpc-schema";
import { ActivityTracker } from "./activity.ts";
import { createAgentRegistry, type AgentRegistry } from "./agents.ts";
import { loadConfig } from "./config-load.ts";
import { bindEngine } from "./engine.ts";
import { buildEngineConfig } from "./engine-config.ts";
import { createHarnessHost } from "./host.ts";
import { replayJournal } from "./journal.ts";
import { acquireCoreLock } from "./lock.ts";
import { createLogger, type HarnessLogger } from "./logger.ts";
import { coreAddress, layout, resolveHome, type Layout } from "./paths.ts";
import { buildMethods } from "./rpc/methods.ts";
import { createRpcServer, type RpcServer } from "./rpc/server.ts";

export interface Core {
  start(): Promise<void>;
  stop(o?: { budgetMs?: number }): Promise<void>;
  status(): CoreStatusResult;
  readonly address: string; readonly token: string; readonly layout: Layout;
}
type State = ProcessState & { since: number };

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; // rpc.schema.json $defs/AgentId

export function createCore(o: { home?: string; instanceId?: string; testInternals?: Record<string, unknown>; clock?: () => number; logger?: HarnessLogger }): Core {
  const home = resolveHome({ ...(o.home ? { home: o.home } : {}) });
  const l = layout(home); const clock = o.clock ?? Date.now;
  const instanceId = o.instanceId ?? randomUUID();
  const token = randomBytes(32).toString("hex");
  const address = coreAddress(home);
  const startedAt = clock();
  const activity = new ActivityTracker(clock);
  let state: State = { state: "starting", since: startedAt };
  let server: RpcServer | null = null; let lock: { release(): void } | null = null;
  let engine: Engine | null = null; let logger: HarnessLogger | null = null; let agents: AgentRegistry | null = null;
  let journalBacklog = 0; let stopping: Promise<void> | null = null; let wroteRunFiles = false;
  // R19: the only signal a capture observes. Aborted at the start of stop(); never a client's disconnect or a wait timer.
  const shutdown = new AbortController();

  const setState = (s: State) => { state = s; server?.notify("core.state", { process: s }); };

  function status(): CoreStatusResult {
    return {
      process: state, contract: engine?.contract ?? "", rpc: RPC_VERSION, instanceId, pid: process.pid, uptimeMs: Math.max(0, Math.round(clock() - startedAt)),
      engine: { ready: state.state === "ready", degraded: state.state === "degraded" ? { reason: state.reason ?? "unknown", capability: "core" } : null },
      agents: (agents?.list() ?? []).map((agentId) => ({ agentId, activity: activity.get(agentId) })), journalBacklog,
    };
  }

  async function start(): Promise<void> {
    for (const d of [l.state, l.run, l.logs, l.agents, l.models, l.journal]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const { config } = loadConfig(l.configPath);
    logger = o.logger ?? createLogger({ file: l.logFile("core"), level: config.core.logLevel, role: "core" });
    try {
      lock = acquireCoreLock(l.coreLock, instanceId);
      const registry = createAgentRegistry({ path: l.configPath }, l, logger); agents = registry;
      registry.list(); // trigger scaffold of initial agents via refresh()
      const engineConfig = buildEngineConfig(config, l);
      const events = (name: string, payload: unknown) => {
        const agentId = (payload as { agentId?: unknown } | null)?.agentId;
        server?.notify("engine.event", { name, ...(typeof agentId === "string" && AGENT_ID.test(agentId) ? { agentId } : {}), payload });
      };
      const host = createHarnessHost({ layout: l, logger, config, engineConfig, agents: registry, events, clock });
      const eng = bindEngine(host, engineConfig, o.testInternals); engine = eng;
      activity.onChange((agentId, a) => server?.notify("agent.activity", { agentId, activity: a }));

      const methods = buildMethods({
        engine: eng, config, agents: registry, activity, logger, status, clock, journalBacklog: () => journalBacklog, captureSignal: shutdown.signal,
        // Deferred so the core.shutdown reply is written before the server closes its connections.
        shutdown: (budgetMs) => { setImmediate(() => { void stop(budgetMs !== undefined ? { budgetMs } : {}); }); },
      });
      server = createRpcServer({ address, token, hello: () => ({ contract: eng.contract, rpc: RPC_VERSION, instanceId, pid: process.pid }), methods, logger });

      const replay = await replayJournal({ dir: l.journal, agents: registry, engine: eng, logger, clock });
      journalBacklog = replay.kept;

      wroteRunFiles = true;
      writeFileSync(l.coreToken, token, { mode: 0o600 });
      writeFileSync(l.corePid, `${process.pid}\n`, { mode: 0o600 });
      await server.listen();
      setState({ state: "ready", since: clock() });
      logger.info("core ready", { instanceId, address, replayed: replay.replayed, kept: replay.kept });
    } catch (e) {
      // Cleanup never replaces the original start error.
      const log = logger;
      log.error("core start failed", { err: e });
      shutdown.abort(new Error("core start failed"));
      await step(log, "engine close", async () => { await engine?.close({ budgetMs: 5_000 }); }); engine = null;
      await step(log, "server close", async () => { await server?.close(); }); server = null;
      await step(log, "lock release", () => { lock?.release(); }); lock = null;
      await step(log, "run files", () => removeRunFiles());
      state = { state: "stopped", since: clock(), reason: "start-failed" };
      if (!o.logger) await step(null, "logger close", () => log.close());
      throw e;
    }
  }

  function removeRunFiles(): void {
    if (!wroteRunFiles) return; // a refused core never touches the running core's token and pid
    rmSync(l.coreToken, { force: true }); rmSync(l.corePid, { force: true }); wroteRunFiles = false;
  }

  /** Runs one shutdown step: a failure is logged and collected, never propagated. */
  async function step(log: HarnessLogger | null, name: string, fn: () => unknown, errors?: unknown[]): Promise<void> {
    try { await fn(); } catch (err) { errors?.push(err); try { log?.error(`stop step failed: ${name}`, { err }); } catch { /* logger gone */ } }
  }

  function stop(so: { budgetMs?: number } = {}): Promise<void> { // not async: every call returns the one settled promise
    if (stopping) return stopping;
    stopping = (async () => {
      setState({ state: "stopping", since: clock() });
      shutdown.abort(new Error("core stopping"));
      const errors: unknown[] = [];
      await step(logger, "engine close", async () => { await engine?.close({ budgetMs: so.budgetMs ?? 30_000 }); }, errors);
      await step(logger, "server close", async () => { await server?.close(); }, errors);
      await step(logger, "lock release", () => { lock?.release(); lock = null; }, errors);
      await step(logger, "run files", () => removeRunFiles(), errors);
      setState({ state: "stopped", since: clock(), ...(errors.length ? { reason: "stop-step-failed" } : {}) });
      await step(logger, "log", () => logger?.info("core stopped", { instanceId, failedSteps: errors.length, ...(errors.length ? { firstError: errors[0] } : {}) }));
      if (!o.logger) await step(null, "logger close", () => logger?.close());
    })();
    return stopping;
  }

  return { start, stop, status, address, token, layout: l };
}
