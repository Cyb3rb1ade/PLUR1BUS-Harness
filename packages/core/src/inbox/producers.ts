// Maps what the source modules already announce (approval events, job ledger failures, media index events, identity audit
// lines, channel warnings, break-glass notices) to inbox entries. Pure functions over an InboxPort: the sources only gain a
// callback, never a behaviour change. Metadata only; the dedupe key makes every repeat a no-op.
import type { BreakGlassNotice } from "../rbac/break-glass.ts";
import { breakglassDraft } from "./migrate.ts";
import type { InboxPort } from "./service.ts";

import { looksLikeToken } from "../rpc/channel-surface.ts";

const PARAM_MAX = 200; // the store's limit for one string param
/** A producer string as a param: token-shaped words masked, whitespace folded, clipped to what the store accepts (a long text must not cost the whole notification). */
const param = (v: string): string => {
  // Tokens hide inside URLs and key=value pairs as well, so every piece between separators is checked.
  const masked = v.replace(/\s+/g, " ").trim().replace(/[^\s/=&?#@]+/g, seg => { const core = seg.replace(/^[("'`]+|[)"'`,.;:]+$/g, ""); return core && looksLikeToken(core) ? seg.replace(core, "[redacted]") : seg; })
    .replace(/[0-9]{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted]"); // a bot token glued to a path segment (".../bot<id>:<secret>/...")
  return masked.length > PARAM_MAX ? masked.slice(0, PARAM_MAX - 1) + "…" : masked;
};
const str = (v: unknown): string | undefined => typeof v === "string" && v !== "" ? v : undefined;
const rec = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null ? v as Record<string, unknown> : {};

/** approval.requested -> an entry for the approving person; approval.resolved closes it (whatever the outcome). */
export function approvalToInbox(port: InboxPort, name: string, payload: unknown): void {
  if (name !== "approval.requested" && name !== "approval.resolved") return;
  const a = rec(rec(payload).approval), id = str(a.id), person = str(a.principal);
  if (!id || !person) return;
  if (name === "approval.resolved") return port.settle({ userId: person }, `approval:${id}`);
  port.publish({ userId: person, kind: "approval", severity: "warning", titleKey: "inbox.approval.requested",
    params: { capability: param(str(a.capability) ?? "unknown") }, ref: { route: "/approvals", objectId: id }, dedupeKey: `approval:${id}` });
}
/** A system job run recorded as failed -> owners and admins (job-failed). One entry per run. */
export function jobFailedToInbox(port: InboxPort, run: { runId: string; job: string; reason?: string }): void {
  port.publish({ audience: "admins", kind: "job-failed", severity: "warning", titleKey: "inbox.jobFailed",
    params: { job: param(run.job), ...(run.reason ? { reason: param(run.reason) } : {}) }, ref: { route: "/recurring", objectId: run.runId }, dedupeKey: `job-failed:${run.runId}` });
}
/** media.index.failed (one per media object) and a finished backfill (one per index fingerprint). Owners and admins. */
export function mediaToInbox(port: InboxPort, name: string, payload: unknown): void {
  const p = rec(payload);
  if (name === "media.index.failed") {
    const mediaId = str(p.mediaId); if (!mediaId) return;
    port.publish({ audience: "admins", kind: "media-index", severity: "warning", titleKey: "inbox.mediaIndex.failed",
      params: { stage: param(str(p.stage) ?? "index") }, ref: { route: "/library", objectId: mediaId }, dedupeKey: `media-index:failed:${mediaId}` });
  } else if (name === "media.index.status" && rec(p.backfill).state === "done") {
    const fp = str(p.fingerprint) ?? "current";
    port.publish({ audience: "admins", kind: "media-index", severity: "info", titleKey: "inbox.mediaIndex.done",
      params: {}, ref: { route: "/library" }, dedupeKey: `media-index:done:${fp}` });
  }
}
/** identity audit lines: a claimed pairing waits for its person's confirmation; any decision closes it. */
export function pairingToInbox(port: InboxPort, e: { action: string; target: string; detail?: unknown }): void {
  const d = rec(e.detail);
  if (e.action === "identity.pair.claim" && d.result === "awaiting-confirmation") {
    const humanId = str(d.humanId); if (!humanId) return;
    port.publish({ userId: humanId, kind: "pairing", severity: "warning", titleKey: "inbox.pairing.requested",
      params: { channel: param(str(d.channel) ?? "unknown") }, ref: { route: "/settings", objectId: e.target }, dedupeKey: `pairing:${e.target}` });
  } else if (e.action === "identity.pair.confirm" || e.action === "identity.pair.revoke") port.settle({ audience: "all" }, `pairing:${e.target}`);
}
/** The switchboard's `channel.misconfigured` warning -> owners and admins; fixed channels re-notify only after the entry aged out. */
export function channelToInbox(port: InboxPort, message: string, fields: unknown): void {
  if (message !== "channel.misconfigured") return;
  const channel = str(rec(fields).channel); if (!channel) return;
  port.publish({ audience: "admins", kind: "channel", severity: "warning", titleKey: "inbox.channel.misconfigured",
    params: { channel: param(channel) }, ref: { route: "/switchboard", objectId: channel }, dedupeKey: `channel:misconfigured:${channel}` });
}
/** The durable notice stays authoritative in admin_notices (fail closed); this is the inbox copy. */
export function breakglassToInbox(port: InboxPort, n: BreakGlassNotice): void {
  const { userId, ...rest } = breakglassDraft(n);
  port.publish({ userId, ...rest });
}
