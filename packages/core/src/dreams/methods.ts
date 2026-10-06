// `dreams.*` over RPC (rpc.schema.json): a thin projection of the scheduler onto the closed wire shapes. A new block,
// spread into `buildMethods`; nothing here decides anything the scheduler does not.
import { requireAgent } from "../memory-ops.ts";
import type { AgentRegistry } from "../agents.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import type { DreamScheduler } from "./scheduler.ts";
import type { DreamRun, Phase, ScheduleRow } from "./types.ts";

export interface DreamsMethodDeps { dreams: () => DreamScheduler | null; agents: AgentRegistry }

const unavailable = () => new RpcError("E_NOT_AVAILABLE", "the dreaming scheduler is not running", { reason: "dreams-unavailable" });

const projectRun = (r: DreamRun) => ({
  runId: r.runId, agentId: r.agentId, phase: r.phase, jobId: r.jobId, partition: r.partition, idempotencyKey: r.idempotencyKey, claimed: r.claimed,
  trigger: r.trigger, scheduledFor: r.scheduledFor, startedAt: r.startedAt, finishedAt: r.finishedAt,
  durationMs: r.finishedAt === null ? null : Math.max(0, r.finishedAt - r.startedAt),
  outcome: r.outcome, reason: r.reason, counts: Object.fromEntries(Object.entries(r.counts).filter(([, v]) => typeof v === "number")) as Record<string, number>,
  tokensIn: r.tokensIn, tokensOut: r.tokensOut, costMicros: r.costMicros, logPath: r.logPath,
  error: r.error ? { message: r.error.message, ...(r.error.name ? { name: r.error.name } : {}) } : null,
});

const projectSchedule = (s: ScheduleRow) => ({ agentId: s.agentId, phase: s.phase, cron: s.cron, timezone: s.timezone, enabled: s.enabled, staggerOffsetS: s.staggerOffsetS, nextRunAt: s.enabled ? s.nextRunAt : null });

export function buildDreamsMethods(d: DreamsMethodDeps): Record<string, Handler> {
  const sched = (): DreamScheduler => { const s = d.dreams(); if (!s) throw unavailable(); return s; };
  const edit = (agentId: string, phase: Phase, patch: { cron?: string; timezone?: string; enabled?: boolean }) => {
    requireAgent(d.agents, agentId);
    try { return { schedule: projectSchedule(sched().setSchedule(agentId, phase, patch)) }; }
    catch (e) {
      if (e instanceof RpcError) throw e;
      const msg = String((e as Error).message ?? e);
      throw new RpcError("E_INVALID_PARAMS", msg, { detail: /timezone/i.test(msg) ? "timezone" : "cron" });
    }
  };

  return {
    "dreams.status": async (p: { agentId?: string }) => {
      if (p.agentId !== undefined) requireAgent(d.agents, p.agentId);
      const st = sched().status(p.agentId);
      return {
        ...st,
        agents: st.agents.map((a) => ({ ...a, phases: a.phases.map((ph) => ({ ...ph, lastRun: ph.lastRun ? projectRun(ph.lastRun) : null })) })),
      };
    },
    "dreams.log": async (p: { agentId?: string; phase?: Phase; runId?: string; limit?: number }) => {
      if (p.agentId !== undefined) requireAgent(d.agents, p.agentId);
      if (p.runId !== undefined) {
        const r = sched().log({ runId: p.runId });
        if (r.runs.length === 0) throw new RpcError("E_NOT_FOUND", `no dream run ${p.runId}`);
        return { runs: r.runs.map(projectRun), ...(r.log !== undefined ? { log: r.log } : {}) };
      }
      return { runs: sched().log({ ...(p.agentId !== undefined ? { agentId: p.agentId } : {}), ...(p.phase !== undefined ? { phase: p.phase } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }).runs.map(projectRun) };
    },
    "dreams.run": async (p: { agentId: string; phase: Phase; dryRun?: boolean }, ctx) => {
      requireAgent(d.agents, p.agentId);
      const s = sched();
      if (p.dryRun === true) return { dryRun: true as const, ...s.plan(p.agentId, p.phase) };
      return projectRun(await s.runPhase(p.agentId, p.phase, { trigger: "manual", signal: ctx.signal }));
    },
    "dreams.schedule.get": async (p: { agentId: string }) => {
      requireAgent(d.agents, p.agentId);
      return { schedules: sched().getSchedules(p.agentId).map(projectSchedule) };
    },
    "dreams.schedule.set": async (p: { agentId: string; phase: Phase; cron?: string; timezone?: string; enabled?: boolean }) =>
      edit(p.agentId, p.phase, { ...(p.cron !== undefined ? { cron: p.cron } : {}), ...(p.timezone !== undefined ? { timezone: p.timezone } : {}), ...(p.enabled !== undefined ? { enabled: p.enabled } : {}) }),
    "dreams.enable": async (p: { agentId: string; phase: Phase }) => edit(p.agentId, p.phase, { enabled: true }),
    "dreams.disable": async (p: { agentId: string; phase: Phase }) => edit(p.agentId, p.phase, { enabled: false }),
  };
}
