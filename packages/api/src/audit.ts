import { createHash } from "node:crypto";
import type { Clock } from "./clock.ts";
import { redactFields } from "./redact.ts";
import type { AuditSink } from "./rbac-bridge.ts";

/** The auth events the API writes (ADR-004 *Audit*, ADR-007 *Authentication*). Names are stable: `docs/api.md` lists them. */
export const AUDIT_ACTIONS = [
  "auth.login.success", "auth.login.failure", "auth.logout", "auth.logout-all", "auth.session.rotated",
  "auth.token.created", "auth.token.revoked", "auth.token.used-denied",
  "auth.totp.enabled", "auth.totp.disabled", "auth.totp.failure", "auth.totp.backup-used",
  "auth.rate-limited", "auth.denied", "auth.csrf-refused",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEmitter {
  /** Never throws: an audit failure is logged and does not turn a request into a 500. (Break-glass is the exception and
   *  fails closed inside the core's registry.) */
  emit(action: AuditAction, actor: string, target: string, detail?: Record<string, unknown>): void;
}

export const noopAudit: AuditEmitter = { emit() {} };

/** A stable, non-reversible handle for a name the caller typed (it may be wrong, foreign or even a pasted secret), so a
 *  failed login can be correlated without the log ever holding what was typed. */
export function nameHandle(typed: string): string {
  return `name:${createHash("sha256").update(typed.normalize("NFC").trim().toLowerCase(), "utf8").digest("hex").slice(0, 16)}`;
}

export interface AuditEmitterOptions {
  sink: AuditSink | undefined; clock: Clock; log: { error(msg: string, f?: Record<string, unknown>): void };
  host?: string;
  /** Repeats of the same noisy event (`auth.rate-limited`) inside this window are dropped, so a flood cannot fill the chain. */
  noisyWindowMs?: number;
}

const NOISY: ReadonlySet<AuditAction> = new Set(["auth.rate-limited", "auth.csrf-refused"]);
const MAX_NOISY_KEYS = 1000;

export function createAuditEmitter(o: AuditEmitterOptions): AuditEmitter {
  if (!o.sink) return noopAudit;
  const sink = o.sink; const host = o.host ?? "api"; const window = o.noisyWindowMs ?? 60_000;
  const lastNoisy = new Map<string, number>();
  return {
    emit(action, actor, target, detail = {}) {
      const now = o.clock.now();
      if (NOISY.has(action)) {
        const k = `${action}\u0000${actor}\u0000${target}`; const prev = lastNoisy.get(k);
        if (prev !== undefined && now - prev < window) return;
        lastNoisy.delete(k); lastNoisy.set(k, now);
        while (lastNoisy.size > MAX_NOISY_KEYS) { const first = lastNoisy.keys().next(); if (first.done) break; lastNoisy.delete(first.value); }
      }
      try { sink.append({ at: now, actor: { user: actor, host }, action, target, detail: redactFields(detail) as Record<string, unknown> }); }
      catch (e) { o.log.error("audit append failed", { action, error: e instanceof Error ? e.name : "non-error thrown" }); }
    },
  };
}
