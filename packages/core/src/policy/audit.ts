// D109 §9 / D9: the policy audit trail. One line per request, decision, grant change, denial and integrity failure, written
// through the existing `AuditSink` (the hash-chained audit file of B5 is one; this module adds no second log).
//
// What a line may carry is an allowlist, not a filter: a key that is not listed here is dropped, so file contents, tool
// results, arguments, environment values and diffs cannot get in by accident. Every string goes through the D111
// redactor (secret-shaped values, URL credentials, credential-store paths) and is length-bounded. A diff or payload is
// recorded as hash + size only (`hashAndSize`). `record` throws when the sink cannot record; a caller that must not act
// unrecorded lets that propagate.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { createRedactor, type Redactor } from "../logs/redact.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { Clock } from "./decide.ts";

export type PolicyAuditAction =
  | "policy.decision" | "policy.outcome"
  | "approval.requested" | "approval.decided" | "approval.parked" | "approval.expired" | "approval.cancelled" | "approval.consumed" | "approval.refused"
  | "grant.created" | "grant.used" | "grant.consumed" | "grant.revoked" | "grant.ended"
  | "approvals.integrity-failure" | "approvals.held-rejected";

/** The closed reasons for a hand-off reference the receiver refused (D104). */
export type HeldRejection = "unknown" | "revoked" | "not-delegable" | "task-mismatch" | "foreign-person";

export interface PolicyAuditFields {
  /** The principal (a person); becomes the audit line's actor. */
  person?: string;
  agentId?: string;
  subjectKind?: string;
  sessionId?: string;
  taskId?: string;
  jobId?: string;
  tool?: string;
  capability?: string;
  effect?: string;
  risk?: string;
  /** `allowed` | `approval` | `never` for a decision; `executed` | `failed` | … for an outcome. */
  outcome?: string;
  /** `default` | `override` | `grant` | `approved` | `ask`. */
  via?: string;
  rule?: string;
  reason?: string;
  grantId?: string;
  grantScope?: string;
  matchKind?: string;
  requestId?: string;
  actionHash?: string;
  /** `approve` | `deny`. */
  decision?: string;
  /** Scope the person chose when deciding. */
  scope?: string;
  /** Surface trust level the call originates from. */
  surface?: number;
  /** Surface trust level the person decided on. */
  decisionSurface?: number;
  by?: string;
  targets?: readonly string[];
  flags?: Readonly<Record<string, boolean>>;
  argsBytes?: number;
  durationMs?: number;
  resultCode?: string;
  resultBytes?: number;
  payloadHash?: string;
  payloadBytes?: number;
  brokenAt?: number;
  failure?: string;
  expiresAt?: number;
  rejected?: readonly { id: string; reason: HeldRejection }[];
}

export interface PolicyAudit {
  record(action: PolicyAuditAction, fields: PolicyAuditFields): void;
}

export interface PolicyAuditOptions {
  sink: AuditSink;
  clock: Clock;
  host?: string;
  /** Exact secret values this process holds (masked wherever they appear). */
  secrets?: Iterable<string>;
  redactor?: Redactor;
}

export const MAX_AUDIT_TARGETS = 20;
const MAX_STRING = 256;
const MAX_PRE_REDACT = 4096;
const MAX_REJECTED = 20;
const MAX_ID = 128;
const AUTH_SCHEME = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const STRING_KEYS = [
  "person", "agentId", "subjectKind", "sessionId", "taskId", "jobId", "tool", "capability", "effect", "risk", "outcome", "via", "rule", "reason",
  "grantId", "grantScope", "matchKind", "requestId", "actionHash", "decision", "scope", "by", "resultCode", "payloadHash", "failure",
] as const;
const NUMBER_KEYS = ["surface", "decisionSurface", "argsBytes", "durationMs", "resultBytes", "payloadBytes", "brokenAt", "expiresAt"] as const;
const FLAG_KEYS = ["outsideRoots", "denyListHit", "privileged", "irreversible", "batch", "shellAllowlisted", "sandboxed", "secretSlotDeclared", "publishPublic", "systemTree"] as const;
const REJECTIONS: readonly string[] = ["unknown", "revoked", "not-delegable", "task-mismatch", "foreign-person"];

export function hashAndSize(text: string): { hash: string; bytes: number } {
  return { hash: createHash("sha256").update(text, "utf8").digest("hex"), bytes: Buffer.byteLength(text, "utf8") };
}

function targetOf(action: PolicyAuditAction, f: PolicyAuditFields): string {
  if (action.startsWith("grant.")) return `grant:${f.grantId ?? "-"}`;
  if (action.startsWith("approval.")) return `approval:${f.requestId ?? "-"}`;
  if (action.startsWith("approvals.")) return "approvals";
  return `tool:${f.tool ?? f.capability ?? "-"}`;
}

export function createPolicyAudit(o: PolicyAuditOptions): PolicyAudit {
  const redactor = o.redactor ?? createRedactor(o.secrets ? { secrets: o.secrets } : {});
  const host = o.host ?? hostname();
  // The shared redactor's `key` rule turns `Authorization: Bearer <token>` into `Authorization: [..] <token>` and leaves the
  // token; masking the scheme + credential first closes that gap here without touching the shared rules.
  const text = (v: string): string => redactor.text((v.length > MAX_PRE_REDACT ? v.slice(0, MAX_PRE_REDACT) : v).replace(AUTH_SCHEME, "[REDACTED:pattern]")).slice(0, MAX_STRING);

  function detailOf(f: PolicyAuditFields): Record<string, unknown> {
    const src = f as Record<string, unknown>;
    const d: Record<string, unknown> = {};
    for (const k of STRING_KEYS) if (typeof src[k] === "string") d[k] = text(src[k] as string);
    for (const k of NUMBER_KEYS) if (typeof src[k] === "number" && Number.isFinite(src[k])) d[k] = src[k];
    if (Array.isArray(src.targets)) {
      const all = (src.targets as unknown[]).filter((t): t is string => typeof t === "string");
      d.targets = all.slice(0, MAX_AUDIT_TARGETS).map(text);
      if (all.length > MAX_AUDIT_TARGETS) d.targetsTotal = all.length;
    }
    if (src.flags !== null && typeof src.flags === "object") {
      const flags: Record<string, boolean> = {};
      for (const k of FLAG_KEYS) if (typeof (src.flags as Record<string, unknown>)[k] === "boolean") flags[k] = (src.flags as Record<string, boolean>)[k]!;
      if (Object.keys(flags).length > 0) d.flags = flags;
    }
    if (Array.isArray(src.rejected)) {
      const rows: { id: string; reason: string }[] = [];
      for (const r of src.rejected as unknown[]) {
        const x = r as { id?: unknown; reason?: unknown } | null;
        if (x && typeof x.id === "string" && typeof x.reason === "string" && REJECTIONS.includes(x.reason)) rows.push({ id: text(x.id).slice(0, MAX_ID), reason: x.reason });
        if (rows.length >= MAX_REJECTED) break;
      }
      d.rejected = rows;
    }
    return d;
  }

  return {
    record(action, fields) {
      o.sink.append({
        at: o.clock.now(),
        actor: { user: typeof fields.person === "string" && fields.person !== "" ? text(fields.person) : typeof fields.by === "string" && fields.by !== "" ? text(fields.by) : "core", host },
        action,
        target: text(targetOf(action, fields)),
        detail: detailOf(fields),
      });
    },
  };
}
