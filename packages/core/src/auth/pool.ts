import type { Clock } from "./clock.ts";
import { AuthError } from "./errors.ts";
import { noLog, type AuthLog } from "./log.ts";

export type Strategy = "fill_first" | "round_robin" | "least_used";
export interface PoolEntry { id: string; secretRef: string; label?: string }

/** Our own reason codes (ADR-005 action 7), not a vendor's vocabulary. */
export type FailureCode = "rate_limited" | "quota_exhausted" | "auth_rejected" | "forbidden";
/** `confirmed`: the vendor said so unambiguously (a quota message, a 401). `ambiguous`: HTTP status alone (a bare 429). */
export type Certainty = "confirmed" | "ambiguous";

export interface Failure {
  status: number;
  /** The model of the failed call; an ambiguous 429 then cools that model only, not the whole credential. */
  model?: string;
  retryAfterMs?: number;
  /** What the adapter could read from the vendor's answer, if anything. */
  hint?: "quota_exhausted" | "rate_limit";
}
export interface Classification { code: FailureCode; certainty: Certainty; scope: "credential" | "model" }

/** Cooldown table. RULING (ADR-005 Q "failure-classified cooldowns", sizes are ours): a confirmed failure cools long, an
 *  ambiguous one briefly, and the credential left alone in the pool cools far shorter than one of several, because
 *  there is nothing to fail over to and a long wait only turns a maybe into a certain outage. A vendor `Retry-After`
 *  replaces the table value (clamped). */
export const COOLDOWN_MS = {
  confirmed: { several: 3_600_000, sole: 300_000 },
  ambiguous: { several: 60_000, sole: 15_000 },
} as const;
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 86_400_000;

/** 429 and 401/403 start a cooldown; every other status is not the credential's fault and cools nothing. */
export function classifyFailure(f: Failure): Classification | null {
  if (f.status === 429) {
    if (f.hint === "quota_exhausted") return { code: "quota_exhausted", certainty: "confirmed", scope: "credential" };
    return { code: "rate_limited", certainty: "ambiguous", scope: f.model ? "model" : "credential" };
  }
  if (f.status === 401) return { code: "auth_rejected", certainty: "confirmed", scope: "credential" };
  if (f.status === 403) return { code: "forbidden", certainty: "ambiguous", scope: f.model ? "model" : "credential" };
  return null;
}

interface Cooldown { until: number; code: FailureCode; certainty: Certainty }
export interface CredentialStatus {
  id: string;
  label?: string;
  uses: number;
  cooldownRemainingMs: number;
  lastError: { code: FailureCode; certainty: Certainty } | null;
  modelCooldowns: Record<string, number>;
}
export interface PoolSnapshot { cooldowns: Array<{ id: string; model?: string; until: number; code: FailureCode; certainty: Certainty }>; uses: Record<string, number>; cursor: number }

export interface CredentialPoolOptions { profileId: string; entries: PoolEntry[]; strategy?: Strategy; clock: Clock; log?: AuthLog }

/** One pool per profile. This is the only cooldown authority: the cron runner and interactive turns ask the same pool,
 *  so they cannot disagree about whether a credential is usable (ADR-005 "Exactly one cooldown authority"). */
export class CredentialPool {
  readonly profileId: string;
  readonly strategy: Strategy;
  readonly #entries: PoolEntry[];
  readonly #clock: Clock;
  readonly #log: AuthLog;
  readonly #cool = new Map<string, Cooldown>();      // credential id
  readonly #coolModel = new Map<string, Cooldown>(); // `${id}\0${model}`
  readonly #uses = new Map<string, number>();
  readonly #last = new Map<string, { code: FailureCode; certainty: Certainty }>();
  #cursor = 0;

  constructor(o: CredentialPoolOptions) {
    this.profileId = o.profileId; this.strategy = o.strategy ?? "fill_first"; this.#entries = [...o.entries];
    this.#clock = o.clock; this.#log = o.log ?? noLog;
    if (new Set(this.#entries.map((e) => e.id)).size !== this.#entries.length) throw new AuthError("invalid_profile", `Credential pool for ${o.profileId} has duplicate credential ids.`, { profileId: o.profileId });
  }

  get size(): number { return this.#entries.length; }

  /** The credential to use for a call to `model`, or an `all_cooling_down` error carrying the earliest retry time. */
  select(o: { model?: string } = {}): PoolEntry {
    if (this.#entries.length === 0) throw new AuthError("no_credential", "No credential is configured for this profile.", { profileId: this.profileId });
    const avail = this.#entries.map((e, i) => ({ e, i })).filter(({ e }) => this.#remaining(e.id, o.model) === 0);
    if (avail.length === 0) {
      const wait = Math.min(...this.#entries.map((e) => this.#remaining(e.id, o.model)));
      throw new AuthError("all_cooling_down", `Every credential for this profile is cooling down; retry in ${Math.ceil(wait / 1000)} s.`, { profileId: this.profileId, retryable: true, retryAfterMs: wait });
    }
    let pick = avail[0]!;
    if (this.strategy === "round_robin") {
      pick = avail.find(({ i }) => i >= this.#cursor) ?? avail[0]!;
      this.#cursor = (pick.i + 1) % this.#entries.length;
    } else if (this.strategy === "least_used") {
      pick = avail.reduce((a, b) => ((this.#uses.get(b.e.id) ?? 0) < (this.#uses.get(a.e.id) ?? 0) ? b : a));
    }
    this.#uses.set(pick.e.id, (this.#uses.get(pick.e.id) ?? 0) + 1);
    return pick.e;
  }

  entry(id: string): PoolEntry | undefined { return this.#entries.find((e) => e.id === id); }

  /** Record a failed call. Returns what was decided, or null when the status is not a credential failure. */
  reportFailure(credentialId: string, f: Failure): { classification: Classification; cooldownMs: number } | null {
    const c = classifyFailure(f);
    if (!c || !this.entry(credentialId)) return null;
    const model = c.scope === "model" ? f.model : undefined;
    // "sole remaining": no other credential is usable for this scope right now.
    const sole = !this.#entries.some((e) => e.id !== credentialId && this.#remaining(e.id, model) === 0);
    const base = COOLDOWN_MS[c.certainty][sole ? "sole" : "several"];
    const ms = f.retryAfterMs !== undefined && Number.isFinite(f.retryAfterMs) ? Math.min(Math.max(f.retryAfterMs, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS) : base;
    const until = this.#clock.now() + ms;
    const map = model ? this.#coolModel : this.#cool;
    const key = model ? `${credentialId}\0${model}` : credentialId;
    const prev = map.get(key);
    if (!prev || prev.until < until) map.set(key, { until, code: c.code, certainty: c.certainty }); // a cooldown is never shortened
    this.#last.set(credentialId, { code: c.code, certainty: c.certainty });
    this.#log("auth.pool.cooldown", { profileId: this.profileId, credentialId, code: c.code, certainty: c.certainty, scope: model ? "model" : "credential", ms, sole });
    return { classification: c, cooldownMs: ms };
  }

  /** A successful call ends an ambiguous cooldown on that scope early; a confirmed one runs its course. */
  reportSuccess(credentialId: string, model?: string): void {
    const c = this.#cool.get(credentialId);
    if (c?.certainty === "ambiguous") this.#cool.delete(credentialId);
    if (model) { const m = this.#coolModel.get(`${credentialId}\0${model}`); if (m?.certainty === "ambiguous") this.#coolModel.delete(`${credentialId}\0${model}`); }
    if (!this.#cool.has(credentialId)) this.#last.delete(credentialId);
  }

  /** Per-credential status for the UI (ADR-005): cooldown remaining and last error with its classification. */
  status(): CredentialStatus[] {
    const now = this.#clock.now();
    return this.#entries.map((e) => {
      const models: Record<string, number> = {};
      for (const [k, v] of this.#coolModel) { const [id, m] = k.split("\0"); if (id === e.id && v.until > now) models[m!] = v.until - now; }
      return { id: e.id, ...(e.label !== undefined ? { label: e.label } : {}), uses: this.#uses.get(e.id) ?? 0, cooldownRemainingMs: this.#remaining(e.id), lastError: this.#last.get(e.id) ?? null, modelCooldowns: models };
    });
  }

  /** Non-secret state, so a later task can persist cooldowns across a restart. */
  snapshot(): PoolSnapshot {
    const cooldowns: PoolSnapshot["cooldowns"] = [];
    for (const [id, v] of this.#cool) cooldowns.push({ id, ...v });
    for (const [k, v] of this.#coolModel) { const [id, model] = k.split("\0"); cooldowns.push({ id: id!, model: model!, ...v }); }
    return { cooldowns, uses: Object.fromEntries(this.#uses), cursor: this.#cursor };
  }

  restore(s: PoolSnapshot): void {
    this.#cool.clear(); this.#coolModel.clear(); this.#uses.clear();
    for (const c of s.cooldowns) {
      if (!this.entry(c.id)) continue;
      const cd = { until: c.until, code: c.code, certainty: c.certainty };
      if (c.model) this.#coolModel.set(`${c.id}\0${c.model}`, cd); else this.#cool.set(c.id, cd);
    }
    for (const [id, n] of Object.entries(s.uses)) if (this.entry(id)) this.#uses.set(id, n);
    this.#cursor = s.cursor % Math.max(1, this.#entries.length);
  }

  /** Milliseconds until `id` is usable for `model` (0 = usable now). */
  #remaining(id: string, model?: string): number {
    const now = this.#clock.now();
    const a = this.#cool.get(id)?.until ?? 0;
    const b = model ? this.#coolModel.get(`${id}\0${model}`)?.until ?? 0 : 0;
    return Math.max(0, a - now, b - now);
  }
}
