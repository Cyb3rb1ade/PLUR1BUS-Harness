import { SCHEMA } from "@plur1bus/rpc-schema";

/** A harness notification projected from one engine event (ADR-016 §6). `audience`, when set, lists the agents whose
 *  filtered subscriptions receive it in place of the `params.agentId` match (G12). */
export interface MappedEvent { method: string; params: Record<string, unknown>; audience?: readonly string[] }

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; // rpc.schema.json $defs/AgentId
const defs = (SCHEMA as any).$defs;
const JOB_TRIGGERS: readonly unknown[] = defs.JobTrigger.enum;
const JOB_OUTCOMES: readonly unknown[] = defs.JobOutcome.enum;
const PROPOSAL_STATUSES: readonly unknown[] = defs.MemoryProposalStatus.enum;
const JOB_PHASES: readonly unknown[] = ["light", "rem", "deep", null];
const DEFERRAL_REASONS: readonly unknown[] = ["global-cap", "memories-cap"];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isAgentId = (v: unknown): v is string => isStr(v) && AGENT_ID.test(v);

/** `$defs/Degraded` is closed: keep reason, capability and detail only. */
function degradedOf(v: unknown): Rec | null {
  if (!isRec(v) || !isStr(v.reason) || !isStr(v.capability)) return null;
  return { reason: v.reason, capability: v.capability, ...(isStr(v.detail) ? { detail: v.detail } : {}) };
}

function recallCompleted(p: Rec): Rec | null {
  const timing = p.timing;
  if (!isAgentId(p.agentId) || !isRec(timing) || !isNum(timing.totalMs)) return null;
  let degraded: Rec | null = null;
  if (p.degraded != null) { degraded = degradedOf(p.degraded); if (!degraded) return null; }
  return { agentId: p.agentId, totalMs: timing.totalMs, degraded };
}

function recallDegraded(p: Rec): Rec | null {
  const degraded = degradedOf(p.degraded);
  return isAgentId(p.agentId) && degraded ? { agentId: p.agentId, degraded } : null;
}

function recallBlock(p: Rec): Rec | null {
  if (!isAgentId(p.agentId) || !isStr(p.block) || !isInt(p.from) || !isInt(p.to) || !DEFERRAL_REASONS.includes(p.reason)) return null;
  return { agentId: p.agentId, block: p.block, from: p.from, to: p.to, reason: p.reason };
}

function jobRun(p: Rec): Rec | null {
  if (!isAgentId(p.agentId) || !isStr(p.runId) || !isStr(p.job) || !JOB_PHASES.includes(p.phase ?? null)
    || !JOB_TRIGGERS.includes(p.trigger) || !JOB_OUTCOMES.includes(p.outcome)
    || !isInt(p.startedAt) || !isInt(p.finishedAt) || !isInt(p.durationMs) || !isInt(p.attempt)) return null;
  return {
    agentId: p.agentId, runId: p.runId, job: p.job, phase: p.phase ?? null, trigger: p.trigger, outcome: p.outcome,
    ...(isStr(p.reason) ? { reason: p.reason } : {}),
    startedAt: p.startedAt, finishedAt: p.finishedAt, durationMs: p.durationMs, attempt: p.attempt,
  };
}

function memoryProposal(p: Rec): Rec | null {
  // Agent ids stay plain strings here: a shared copy may come from another host's agent (Review Focus 1).
  if (!isStr(p.proposalId) || !PROPOSAL_STATUSES.includes(p.status) || !isStr(p.sharerAgentId) || !isStr(p.proposerAgentId) || !isStr(p.sharedId)) return null;
  return { agentId: p.sharerAgentId, proposalId: p.proposalId, status: p.status, sharerAgentId: p.sharerAgentId, proposerAgentId: p.proposerAgentId, sharedId: p.sharedId };
}

/** G11: declared but not emitted by the pinned engine; project agentId only, never invent payload fields. */
const agentOnly = (required: boolean) => (p: Rec): Rec | null => {
  if (p.agentId === undefined) return required ? null : {};
  return isAgentId(p.agentId) ? { agentId: p.agentId } : null;
};

const PROJECTIONS: Record<string, (p: Rec) => Rec | null> = {
  "recall.completed": recallCompleted,
  "recall.degraded": recallDegraded,
  "recall.block-clipped": recallBlock,
  "recall.block-dropped": recallBlock,
  "job.run": jobRun,
  "memory.proposal": memoryProposal,
  "dream.completed": agentOnly(true),
  "acl.denied": agentOnly(false),
  "embedding.identity.changed": agentOnly(false),
};

/** Projects an engine event onto its harness notification: only the schema's fields, never the engine's internals
 *  (timing phases, job counts/cost/keys, …). `null` for an unknown name, a missing or ill-typed required field, or an
 *  `agentId` outside `$defs/AgentId` where the notification types it so. */
export function mapEngineEvent(name: string, payload: unknown): MappedEvent | null {
  const project = Object.hasOwn(PROJECTIONS, name) ? PROJECTIONS[name] : undefined;
  if (!project || !isRec(payload)) return null;
  const params = project(payload);
  if (!params) return null;
  if (name === "memory.proposal") return { method: name, params, audience: [params.sharerAgentId as string, params.proposerAgentId as string] };
  return { method: name, params };
}
