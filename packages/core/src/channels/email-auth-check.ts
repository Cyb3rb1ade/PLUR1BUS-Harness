// Doctor finding for the e-mail channel: while `requireAuthPass` is off, the From address alone identifies the sender of a text turn
// (anyone can forge it), so a forged mail from an allowlisted address runs as the person that address is linked to. Pairing and
// approvals by e-mail are DMARC-gated whatever this says; the plain text turn is not. Read-only: nothing is changed.
export type EmailAuthCheck = { id: string; status: "ok" | "warn"; summary: string; repair?: { kind: string; label: string } };

/** The finding for the live configuration, or `null` when the e-mail channel is not enabled (nothing to report). */
export function emailAuthChecks(cfg: unknown): EmailAuthCheck[] {
  const channels = (cfg as { channels?: Record<string, unknown> } | null | undefined)?.channels;
  const email = channels && Object.hasOwn(channels, "email") ? channels.email as { enabled?: unknown; requireAuthPass?: unknown } | null : null;
  if (!email || typeof email !== "object" || email.enabled !== true) return [];
  if (email.requireAuthPass === true) return [{ id: "channels.email.auth", status: "ok", summary: "E-mail channel requires a DMARC pass for every mail." }];
  return [{
    id: "channels.email.auth",
    status: "warn",
    summary: "E-mail channel: channels.email.requireAuthPass is off, so the From address alone identifies the sender. A forged From of an allowlisted, linked address runs a turn with that person's rights. Pairing and approvals by e-mail still need a DMARC pass.",
    repair: { kind: "config", label: "Set channels.email.requireAuthPass to true and channels.email.authServId to your mail server's authserv-id (see docs/channels/email.md), or keep the allowlist to senders whose domains enforce DMARC." },
  }];
}
