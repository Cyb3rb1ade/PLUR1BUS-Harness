import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
  let journalBacklog = 0; let stopping: Promise<void> | null = null;

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
      const registry = createAgentRegistry(config, l); agents = registry;
      for (const id of registry.list()) registry.scaffold(id);
      const engineConfig = buildEngineConfig(config, l);
      const events = (name: string, payload: unknown) => {
        const agentId = (payload as { agentId?: unknown } | null)?.agentId;
        server?.notify("engine.event", { name, ...(typeof agentId === "string" && AGENT_ID.test(agentId) ? { agentId } : {}), payload });
      };
      const host = createHarnessHost({ layout: l, logger, config, engineConfig, agents: registry, events, clock });
      const eng = bindEngine(host, engineConfig, o.testInternals); engine = eng;
      activity.onChange((agentId, a) => server?.notify("agent.activity", { agentId, activity: a }));

      const methods = buildMethods({
        engine: eng, config, agents: registry, activity, logger, status, clock, journalBacklog: () => journalBacklog,
        // Deferred so the core.shutdown reply is written before the server closes its connections.
        shutdown: (budgetMs) => { setImmediate(() => { void stop(budgetMs !== undefined ? { budgetMs } : {}); }); },
      });
      server = createRpcServer({ address, token, hello: () => ({ contract: eng.contract, rpc: RPC_VERSION, instanceId, pid: process.pid }), methods, logger });

      const replay = await replayJournal({ dir: l.journal, agents: registry, engine: eng, logger, clock });
      journalBacklog = replay.kept;

      writeFileSync(l.coreToken, token, { mode: 0o600 });
      writeFileSync(l.corePid, `${process.pid}\n`, { mode: 0o600 });
      await server.listen();
      setState({ state: "ready", since: clock() });
      logger.info("core ready", { instanceId, address, replayed: replay.replayed, kept: replay.kept });
    } catch (e) {
      logger.error("core start failed", { err: e });
      await engine?.close({ budgetMs: 5_000 });
      await server?.close().catch(() => {});
      lock?.release(); lock = null;
      state = { state: "stopped", since: clock(), reason: "start-failed" };
      if (!o.logger) await logger.close();
      throw e;
    }
  }

  async function stop(so: { budgetMs?: number } = {}): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      setState({ state: "stopping", since: clock() });
      await engine?.close({ budgetMs: so.budgetMs ?? 30_000 });
      await server?.close();
      lock?.release(); lock = null;
      setState({ state: "stopped", since: clock() });
      logger?.info("core stopped", { instanceId });
      if (!o.logger) await logger?.close();
    })();
    return stopping;
  }

  return { start, stop, status, address, token, layout: l };
}
