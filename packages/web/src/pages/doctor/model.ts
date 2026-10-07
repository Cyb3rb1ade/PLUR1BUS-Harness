// Wire shapes of the Doctor page and their defensive readers. Pure (no DOM, no preact), so it is unit-tested directly.
// Sources: GET /api/v1/health (health/1) and GET /api/v1/agents (agents.list/1) are real routes (packages/api/src/routes.ts);
// core.status is the documented RPC of docs/rpc.md (CoreStatus), assumed on /rpc until the backend serves it;
// 1staid.check/1 is the document `plur1bus 1staid check --json` prints (crates/plur1bus/src/commands/firstaid.rs).
// A reader never throws: anything that is not the documented shape is null, and the page shows that part as unavailable.

export type HealthStatus = "ok" | "degraded" | "down";
export type Health = {
  status: HealthStatus;
  apiVersion: string;
  core: { reachable: boolean; rpc?: string; contract?: string; uptimeMs?: number; engineReady?: boolean; degraded?: boolean };
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

export function parseHealth(body: unknown): Health | null {
  if (!isObj(body)) return null;
  const status = body.status;
  if (status !== "ok" && status !== "degraded" && status !== "down") return null;
  const api = body.api;
  const core = body.core;
  if (!isObj(api) || typeof api.version !== "string" || !isObj(core) || typeof core.reachable !== "boolean") return null;
  const rpc = str(core.rpc), contract = str(core.contract), uptimeMs = num(core.uptimeMs), engineReady = bool(core.engineReady), degraded = bool(core.degraded);
  return {
    status, apiVersion: api.version,
    core: {
      reachable: core.reachable,
      ...(rpc === undefined ? {} : { rpc }), ...(contract === undefined ? {} : { contract }), ...(uptimeMs === undefined ? {} : { uptimeMs }),
      ...(engineReady === undefined ? {} : { engineReady }), ...(degraded === undefined ? {} : { degraded }),
    },
  };
}

export const ACTIVITY_STATES = ["idle", "recalling", "capturing", "checkpointing", "dreaming", "consolidating", "maintenance"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];
export type DreamPhase = "light" | "rem" | "deep";
export type Activity = { state: ActivityState; since: number; phase?: DreamPhase };
export type Agent = { agentId: string; open: boolean; activity: Activity };

function parseActivity(v: unknown): Activity | null {
  if (!isObj(v)) return null;
  const state = (ACTIVITY_STATES as readonly unknown[]).includes(v.state) ? (v.state as ActivityState) : null;
  const since = num(v.since);
  if (state === null || since === undefined) return null;
  const phase = v.phase === "light" || v.phase === "rem" || v.phase === "deep" ? v.phase : undefined;
  return { state, since, ...(phase ? { phase } : {}) };
}

export function parseAgents(body: unknown): Agent[] | null {
  if (!isObj(body) || !Array.isArray(body.agents)) return null;
  const out: Agent[] = [];
  for (const a of body.agents) {
    if (!isObj(a) || typeof a.agentId !== "string") return null;
    const activity = parseActivity(a.activity);
    if (!activity) return null;
    out.push({ agentId: a.agentId, open: a.open === true, activity });
  }
  return out;
}

export type Degraded = { reason: string; capability: string; detail?: string };
export type ModelState = { state: "loading" | "ready" | "failed" | "disabled"; warming: boolean };
export type CoreStatus = {
  process: { state: string; reason?: string };
  engine: {
    ready: boolean;
    degraded: Degraded | null;
    models?: { embedder: ModelState; reranker: ModelState };
    sharedMemory?: { supported: boolean; mode: string };
    storeSchema?: { current: string | null; expected: string };
  };
};

function parseModel(v: unknown): ModelState | null {
  if (!isObj(v)) return null;
  const s = v.state;
  if (s !== "loading" && s !== "ready" && s !== "failed" && s !== "disabled") return null;
  return { state: s, warming: v.warming === true };
}

export function parseCoreStatus(body: unknown): CoreStatus | null {
  if (!isObj(body) || !isObj(body.process) || typeof body.process.state !== "string" || !isObj(body.engine) || typeof body.engine.ready !== "boolean") return null;
  const e = body.engine;
  let degraded: Degraded | null = null;
  if (isObj(e.degraded)) {
    const reason = str(e.degraded.reason), capability = str(e.degraded.capability), detail = str(e.degraded.detail);
    if (reason === undefined || capability === undefined) return null;
    degraded = { reason, capability, ...(detail === undefined ? {} : { detail }) };
  }
  const reason = str(body.process.reason);
  const out: CoreStatus = { process: { state: body.process.state, ...(reason === undefined ? {} : { reason }) }, engine: { ready: body.engine.ready, degraded } };
  if (isObj(e.models)) {
    const embedder = parseModel(e.models.embedder), reranker = parseModel(e.models.reranker);
    if (embedder && reranker) out.engine.models = { embedder, reranker };
  }
  const sm = e.sharedMemory;
  if (isObj(sm) && typeof sm.supported === "boolean" && typeof sm.mode === "string") out.engine.sharedMemory = { supported: sm.supported, mode: sm.mode };
  const ss = e.storeSchema;
  if (isObj(ss) && typeof ss.expected === "string" && (ss.current === null || typeof ss.current === "string")) out.engine.storeSchema = { current: ss.current, expected: ss.expected };
  return out;
}

const UNITS = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000], ["second", 1000]] as const;

/** "1 day, 3 hr": the two largest non-zero units, short style, in the page language (Intl). */
export function formatUptime(ms: number, locale: string): string {
  let rest = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  const parts: string[] = [];
  for (const [unit, size] of UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 && parts.length < 2) parts.push(new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(n));
  }
  return parts.length > 0 ? parts.join(", ") : new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "short" }).format(0);
}

// ---- 1staid.check/1 -------------------------------------------------------------------------------------------------
export const CHECK_SCHEMA = "1staid.check/1";
export const CHECK_STATUSES = ["ok", "info", "warn", "fail", "skip"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
/** `detail` (free-form, may carry paths) is deliberately not read: it is never shown, only kept in the raw text. */
export type CheckItem = { id: string; status: CheckStatus; summary: string; hint?: string };
export type CheckDoc = { ok: boolean; checks: CheckItem[] };
export const MAX_CHECK_BYTES = 1_000_000;
export type CheckParse = { ok: true; doc: CheckDoc; raw: string } | { ok: false; reason: "too-large" | "not-json" | "wrong-schema" | "malformed" };

export function parseCheckDoc(raw: string): CheckParse {
  if (raw.length > MAX_CHECK_BYTES) return { ok: false, reason: "too-large" };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { ok: false, reason: "not-json" }; }
  if (!isObj(v) || v.schema !== CHECK_SCHEMA) return { ok: false, reason: "wrong-schema" };
  if (typeof v.ok !== "boolean" || !Array.isArray(v.checks)) return { ok: false, reason: "malformed" };
  const checks: CheckItem[] = [];
  for (const c of v.checks) {
    if (!isObj(c) || typeof c.id !== "string" || typeof c.summary !== "string" || !(CHECK_STATUSES as readonly unknown[]).includes(c.status)) return { ok: false, reason: "malformed" };
    const hint = str(c.hint);
    checks.push({ id: c.id, status: c.status as CheckStatus, summary: c.summary, ...(hint === undefined ? {} : { hint }) });
  }
  return { ok: true, doc: { ok: v.ok, checks }, raw };
}
