// The Harness's own migration checkpoint (docs/superpowers/plans/2026-10-06-m2-reembed-migration.md): orchestration state that
// survives a core restart. Position inside the generation stays the engine's (its durable cursor); this file only says
// which migration is ours, what phase the run is in and whether an abort was asked for. One file per home, atomic
// replace, 0600; a file that fails validation is refused loudly and left in place, never reset.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import type { EmbeddingFingerprint } from "./probe.ts";
import type { PrivacyAcknowledgment } from "@plur1bus/config-schema";

export const PHASES = ["planned", "running", "aborted", "validating", "ready-to-switch", "switched", "failed"] as const;
export type Phase = (typeof PHASES)[number];
/** Phases from which no further engine work happens. `aborted` is not terminal: a later run continues the same migration. */
export const TERMINAL: readonly Phase[] = ["switched", "failed"];
export const MAX_STATE_BYTES = 1024 * 1024;

export interface Checkpoint {
  v: 1;
  id: string;
  /** The plan-bound confirmation nonce the engine asks for on apply/resume (not a credential). */
  token: string;
  planDigest: string;
  createdAt: number; updatedAt: number;
  phase: Phase;
  sourceGeneration: string; targetGeneration: string;
  target: EmbeddingFingerprint;
  counts: { rows: number; tables: number; batches: number; rowsDone: number; batchesDone: number };
  throttleMs: number;
  abortRequested: boolean;
  error: { code: string; message: string } | null;
  /**
   * A cloud or self-hosted target (absent for a local one): the NAME of the environment variable holding its key (never the
   * key), the endpoint as configured (the fingerprint keeps a normalised copy) and the per-card token estimate the budget
   * reserves against before each batch.
   */
  remote?: { apiKeyEnv: string; baseUrl?: string; tokensPerRow: number; privacyAck?: PrivacyAcknowledgment };
  /** The engine plan's estimates, kept so planning the same target again answers this plan instead of a second one, which
   *  the engine refuses while this one's confirmation lives. Never part of the public checkpoint. */
  estimate?: PlanEstimate;
}

export interface PlanEstimate {
  providerCalls: number; sourceBytes: number; targetBytes: number; requiredFreeBytes: number; freeBytes: number; probeStatus: string;
  cloud?: { provider: string; model: string; endpoint: string; cards: number; estimatedTokens: number; sendsText: true };
}

export class MigrationStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "MigrationStateError"; this.code = code; }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validates parsed JSON and projects it onto exactly the checkpoint's keys. */
function parse(raw: unknown): Checkpoint {
  const bad = (why: string): never => { throw new MigrationStateError("state-corrupt", `migration checkpoint is invalid (${why})`); };
  if (!isObj(raw)) return bad("not an object");
  if (raw.v !== 1) bad("unsupported version");
  const str = (k: string) => (typeof raw[k] === "string" && (raw[k] as string).length > 0 && (raw[k] as string).length <= 4096 ? (raw[k] as string) : bad(k));
  const id = str("id"); if (!ID_RE.test(id)) bad("id");
  const gens = [str("sourceGeneration"), str("targetGeneration")]; for (const g of gens) if (!ID_RE.test(g)) bad("generation");
  const phase = raw.phase; if (!PHASES.includes(phase as Phase)) bad("phase");
  const c = raw.counts; if (!isObj(c) || !isInt(c.rows) || !isInt(c.tables) || !isInt(c.batches) || !isInt(c.rowsDone) || !isInt(c.batchesDone)) bad("counts");
  const counts = c as Record<string, number>;
  if (!isObj(raw.target) || typeof raw.target.provider !== "string" || typeof raw.target.model !== "string" || !isInt(raw.target.dimensions)) bad("target");
  if (!isInt(raw.createdAt) || !isInt(raw.updatedAt) || !isInt(raw.throttleMs) || typeof raw.abortRequested !== "boolean") bad("scalars");
  let error: Checkpoint["error"] = null;
  if (raw.error !== null) {
    const e = raw.error; if (!isObj(e) || typeof e.code !== "string" || typeof e.message !== "string") bad("error");
    error = { code: (e as { code: string }).code, message: (e as { message: string }).message };
  }
  let remote: Checkpoint["remote"];
  if (raw.remote !== undefined) {
    const r = raw.remote;
    if (!isObj(r) || typeof r.apiKeyEnv !== "string" || !ENV_RE.test(r.apiKeyEnv) || !isInt(r.tokensPerRow) || (r.baseUrl !== undefined && (typeof r.baseUrl !== "string" || r.baseUrl.length > 2048))) bad("remote");
    const o = r as { apiKeyEnv: string; baseUrl?: string; tokensPerRow: number; privacyAck?: unknown };
    let privacyAck: PrivacyAcknowledgment | undefined;
    if (o.privacyAck !== undefined) {
      const a = o.privacyAck;
      if (!isObj(a) || typeof a.provider !== "string" || typeof a.acknowledgedAt !== "string" || typeof a.by !== "string" || (a.endpoint !== undefined && typeof a.endpoint !== "string")) bad("remote.privacyAck");
      const k = a as Record<string, string>;
      privacyAck = { provider: k.provider!, acknowledgedAt: k.acknowledgedAt!, by: k.by!, ...(k.endpoint !== undefined ? { endpoint: k.endpoint } : {}) };
    }
    remote = { apiKeyEnv: o.apiKeyEnv, ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}), tokensPerRow: o.tokensPerRow, ...(privacyAck ? { privacyAck } : {}) };
  }
  let estimate: PlanEstimate | undefined;
  if (raw.estimate !== undefined) {
    const e = raw.estimate;
    if (!isObj(e) || ![e.providerCalls, e.sourceBytes, e.targetBytes, e.requiredFreeBytes, e.freeBytes].every(isInt) || typeof e.probeStatus !== "string" || e.probeStatus.length > 128) bad("estimate");
    const o = e as Record<string, unknown>;
    let cloud: PlanEstimate["cloud"];
    if (o.cloud !== undefined) {
      const k = o.cloud;
      if (!isObj(k) || typeof k.provider !== "string" || typeof k.model !== "string" || typeof k.endpoint !== "string" || !isInt(k.cards) || !isInt(k.estimatedTokens) || k.sendsText !== true) bad("estimate.cloud");
      const v = k as Record<string, unknown>;
      cloud = { provider: v.provider as string, model: v.model as string, endpoint: v.endpoint as string, cards: v.cards as number, estimatedTokens: v.estimatedTokens as number, sendsText: true };
    }
    estimate = { providerCalls: o.providerCalls as number, sourceBytes: o.sourceBytes as number, targetBytes: o.targetBytes as number, requiredFreeBytes: o.requiredFreeBytes as number, freeBytes: o.freeBytes as number, probeStatus: o.probeStatus as string, ...(cloud ? { cloud } : {}) };
  }
  return {
    v: 1, id, token: str("token"), planDigest: str("planDigest"), createdAt: raw.createdAt as number, updatedAt: raw.updatedAt as number, phase: phase as Phase,
    sourceGeneration: gens[0]!, targetGeneration: gens[1]!, target: raw.target as unknown as EmbeddingFingerprint,
    counts: { rows: counts.rows!, tables: counts.tables!, batches: counts.batches!, rowsDone: counts.rowsDone!, batchesDone: counts.batchesDone! },
    throttleMs: raw.throttleMs as number, abortRequested: raw.abortRequested as boolean, error,
    ...(remote ? { remote } : {}), ...(estimate ? { estimate } : {}),
  };
}

export interface StateStore {
  readonly path: string;
  /** null when there is none; throws MigrationStateError `state-corrupt` when the file is unusable. */
  read(): Checkpoint | null;
  write(c: Checkpoint): void;
}

export interface StateStoreOptions { /** Test seam: the atomic-replace step. */ rename?: typeof renameSync }

export function createStateStore(stateDir: string, o: StateStoreOptions = {}): StateStore {
  const dir = path.join(stateDir, "reembed");
  const file = path.join(dir, "migration.json");
  const rename = o.rename ?? renameSync;
  return {
    path: file,
    read() {
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new MigrationStateError("state-unreadable", "migration checkpoint cannot be read"); }
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new MigrationStateError("state-corrupt", "migration checkpoint is invalid (oversized)");
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new MigrationStateError("state-corrupt", "migration checkpoint is invalid (not JSON)"); }
      return parse(json);
    },
    write(c) {
      const body = JSON.stringify(parse(c)); // validates and drops every key that is not the checkpoint's own
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      try { chmodSync(tmp, 0o600); rename(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
    },
  };
}
