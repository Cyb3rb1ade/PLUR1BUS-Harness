// One lifecycle admission boundary for CLI RPC, channel/ACP turns and scheduler work. In-flight turns finish normally.
import type { AgentRegistry } from "../agents.ts";
import type { AgentLifecycle } from "./lifecycle.ts";
import type { Handler } from "../rpc/server.ts";
import { RpcError } from "../rpc/errors.ts";
export function activeAgents(registry: AgentRegistry, lifecycle: AgentLifecycle): AgentRegistry {
  return { list: () => registry.list().filter(id => lifecycle.usable(id)), has: id => registry.has(id) && lifecycle.usable(id), scaffold: id => registry.scaffold(id), workspaceOf: id => lifecycle.usable(id) ? registry.workspaceOf(id) : undefined };
}
/** The read/export registry remains complete; execution paths reject before invoking the old handler. */
export function lifecycleAdmission(handlers: Record<string, Handler>, lifecycle: AgentLifecycle, sessionAgent: (id: string) => string | undefined): Record<string, Handler> {
  const out = { ...handlers };
  for (const method of ["agent.open", "session.create", "session.submit", "memory.capture", "jobs.run", "dreams.run"]) {
    const inner = out[method]; if (!inner) continue;
    out[method] = async (p, ctx) => {
      const id = method === "session.submit" ? sessionAgent(p?.sessionId) : p?.agentId;
      if (typeof id === "string" && !lifecycle.usable(id)) {
        const state = lifecycle.state(id);
        throw new RpcError(state.deleted ? "E_NOT_FOUND" : "E_CONFLICT", "agent does not admit new work", { reason: state.deleted ? "deleted" : state.archived ? "archived" : "paused" });
      }
      return inner(p, ctx);
    };
  }
  return out;
}

/** Engine jobs launched outside RPC (dreams/post-turn) pass the same gate. Already running jobs finish normally. */
export function lifecycleEngine(engine: import("@cyb3rb1ade/plur1bus-memory/types/engine.js").Engine, lifecycle: AgentLifecycle): import("@cyb3rb1ade/plur1bus-memory/types/engine.js").Engine {
  return { ...engine, jobs: { ...engine.jobs, run: async (job, id, options) => {
    if (!lifecycle.usable(id)) throw new RpcError("E_CONFLICT", "agent background work is suspended", { reason: lifecycle.state(id).archived ? "archived" : "paused" });
    return engine.jobs.run(job,id,options);
  } } };
}
