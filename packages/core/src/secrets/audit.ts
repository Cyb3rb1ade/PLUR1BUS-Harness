import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import type { SecurePath } from "@plur1bus/module-api";
import { SecretError, type SecretPrincipal } from "./types.ts";

export type AuditAction =
  | "secret.set" | "secret.get" | "secret.reveal" | "secret.delete" | "secret.list"
  | "secret.lease" | "secret.lease.read" | "secret.lease.revoke" | "secret.denied";

/** Only these keys, only primitives: the audit detail cannot carry a value even by mistake. */
const DETAIL_KEYS = ["backend", "purpose", "profileId", "leaseId", "ttlMs", "reason", "count", "method"] as const;
export type AuditDetail = Partial<Record<(typeof DETAIL_KEYS)[number], string | number | boolean>>;

export interface AuditEvent { action: AuditAction; target: string | null; principal: SecretPrincipal; detail?: AuditDetail }
/** Throws when the line could not be made durable: the store then refuses the operation (ruling R4). */
export interface AuditSink { record(e: AuditEvent): void }

export function sanitizeDetail(d: AuditDetail | undefined): AuditDetail {
  const out: AuditDetail = {};
  for (const k of DETAIL_KEYS) { const v = d?.[k]; if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = typeof v === "string" ? v.slice(0, 128) : v; }
  return out;
}

const actorOf = (p: SecretPrincipal) => ({
  user: p.kind === "owner" ? (p.id ?? userInfo().username) : p.kind === "agent" ? `agent:${p.agentId ?? "unknown"}` : "core",
  host: hostname(),
});

/** `logs/audit.log`: the same line shape as crates/plur1bus/src/audit.rs (`{ at, actor, action, target, detail }`), one
 *  `O_APPEND` write per line, fsynced, private to the user. */
export function createFileAuditSink(o: { file: string; secure: SecurePath; clock?: () => number }): AuditSink {
  const clock = o.clock ?? Date.now;
  return {
    record(e) {
      try {
        mkdirSync(path.dirname(o.file), { recursive: true, mode: 0o700 });
        const fd = openSync(o.file, "a", 0o600);
        try {
          o.secure(o.file);
          writeSync(fd, `${JSON.stringify({ at: clock(), actor: actorOf(e.principal), action: e.action, target: e.target, detail: sanitizeDetail(e.detail) })}\n`);
          fsyncSync(fd);
        } finally { closeSync(fd); }
      } catch { throw new SecretError("audit-unavailable", "the audit log cannot be written; no secret was released or changed"); }
    },
  };
}

/** For tests and for hosts without an audit file. */
export function createMemoryAuditSink(): AuditSink & { events: AuditEvent[]; failNext: boolean } {
  const self = {
    events: [] as AuditEvent[], failNext: false,
    record(e: AuditEvent) {
      if (self.failNext) throw new SecretError("audit-unavailable", "the audit log cannot be written; no secret was released or changed");
      self.events.push({ ...e, detail: sanitizeDetail(e.detail) });
    },
  };
  return self;
}
