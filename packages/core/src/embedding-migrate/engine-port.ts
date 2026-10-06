// The ReembedEngine port over the pinned engine's `Engine.admin.reembedding` (lib/reembedding/coordinator.js). The contract
// types its members as parameterless `Promise<unknown>`; the coordinator takes `plan(request)`, `apply({id, token})`,
// `resume({id, token})` and `status(id)`. Results are projected onto exactly the fields the driver reads, so the engine's
// persisted confirmation hash and any extra record fields never travel further. `validate` exists only if the engine
// exposes it (the pinned contract does not): the driver then stops at `validating`, fail closed.
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { EmbeddingFingerprint } from "./probe.ts";
import type { EnginePlan, EngineRecord, EngineState, EngineTable, PlanRequest, ReembedEngine } from "./port.ts";

/** The coordinator's own default (DEFAULT_LIMITS.batchSize); the plan's batch arithmetic uses it. */
export const ENGINE_BATCH_SIZE = 8;

type Admin = Engine["admin"]["reembedding"];
type Loose = Record<string, unknown>;
const bad = (what: string): never => { throw new Error(`engine re-embedding answer is malformed (${what})`); };
const obj = (v: unknown, what: string): Loose => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : bad(what));
const str = (v: unknown, what: string): string => (typeof v === "string" && v.length > 0 ? v : bad(what));
const int = (v: unknown, what: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(what));

const STATES: readonly string[] = ["planned", "confirmed", "running", "validating", "ready_to_switch", "switching", "completed", "failed", "rollback_planned", "rolling_back", "rolled_back"];

function tables(v: unknown): EngineTable[] {
  if (!Array.isArray(v)) return bad("tables");
  return v.map((t) => { const o = obj(t, "table"); return { tableId: str(o.tableId, "tableId"), version: str(o.version, "version"), rowCount: int(o.rowCount, "rowCount"), estimatedBytes: int(o.estimatedBytes, "estimatedBytes") }; });
}
const fingerprint = (v: unknown): EmbeddingFingerprint => obj(v, "fingerprint") as unknown as EmbeddingFingerprint;

function toRecord(v: unknown): EngineRecord {
  const r = obj(v, "record"); const c = obj(r.cursor, "cursor"); const s = obj(r.source, "source"); const t = obj(r.target, "target");
  if (!STATES.includes(r.state as string)) bad("state");
  const e = r.error;
  return {
    id: str(r.id, "id"), state: r.state as EngineState,
    cursor: { tableIndex: int(c.tableIndex, "tableIndex"), offset: int(c.offset, "offset"), completedRows: int(c.completedRows, "completedRows"), providerCalls: int(c.providerCalls, "providerCalls"), bytes: int(c.bytes, "bytes") },
    source: { generation: str(s.generation, "source.generation"), fingerprintId: str(s.fingerprintId, "source.fingerprintId"), fingerprint: fingerprint(s.fingerprint), tables: tables(s.tables) },
    target: { generation: str(t.generation, "target.generation"), fingerprintId: str(t.fingerprintId, "target.fingerprintId"), fingerprint: fingerprint(t.fingerprint) },
    error: e && typeof e === "object" && typeof (e as Loose).code === "string" ? { code: (e as Loose).code as string } : null,
  };
}

function toPlan(v: unknown): EnginePlan {
  const r = obj(v, "plan result"); const p = obj(r.plan, "plan"); const s = obj(p.source, "source"); const t = obj(p.target, "target"); const est = obj(p.estimates, "estimates");
  return {
    plan: {
      id: str(p.id, "id"),
      source: { generation: str(s.generation, "source.generation"), fingerprintId: str(s.fingerprintId, "source.fingerprintId"), fingerprint: fingerprint(s.fingerprint), tables: tables(s.tables) },
      target: { generation: str(t.generation, "target.generation"), fingerprintId: str(t.fingerprintId, "target.fingerprintId"), fingerprint: fingerprint(t.fingerprint), probeStatus: str(t.probeStatus, "target.probeStatus") },
      estimates: { rows: int(est.rows, "rows"), providerCalls: int(est.providerCalls, "providerCalls"), sourceBytes: int(est.sourceBytes, "sourceBytes"), targetBytes: int(est.targetBytes, "targetBytes"), requiredFreeBytes: int(est.requiredFreeBytes, "requiredFreeBytes"), freeBytes: int(est.freeBytes, "freeBytes") },
    },
    planDigest: str(r.planDigest, "planDigest"),
    confirmation: { token: str(obj(r.confirmation, "confirmation").token, "confirmation.token") },
  };
}

export function createEnginePort(engine: Pick<Engine, "admin">): ReembedEngine {
  const admin = engine.admin.reembedding as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>;
  const call = (name: string, ...args: unknown[]): Promise<unknown> => {
    const fn = admin[name];
    if (typeof fn !== "function") return Promise.reject(new Error(`the engine does not expose admin.reembedding.${name}`));
    return fn.apply(engine.admin.reembedding, args);
  };
  const port: ReembedEngine = {
    batchSize: ENGINE_BATCH_SIZE,
    plan: async (req: PlanRequest) => toPlan(await call("plan", req)),
    apply: async (a) => toRecord(await call("apply", { id: a.id, token: a.token })),
    resume: async (a) => toRecord(await call("resume", { id: a.id, token: a.token })),
    status: async (id) => { const r = await call("status", id); return r === undefined || r === null ? null : toRecord(r); },
  };
  if (typeof admin.validate === "function") port.validate = async (a) => toRecord(await call("validate", { id: a.id }));
  return port;
}
