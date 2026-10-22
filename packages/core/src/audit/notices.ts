// Audit warnings use the existing person-scoped system inbox. No audit record text crosses this boundary.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { InboxPort } from "../inbox/service.ts";
import type { AuditHealth } from "./health.ts";
const HOUR = 3_600_000;
const CODES = new Set(["anchor-missing", "anchor-invalid", "chain-shorter-than-anchor", "tail-anchor-mismatch",
  "tail-malformed", "sequence-exhausted", "rotation-target-exists", "lock-timeout", "audit-unreadable", "audit-unavailable"]);
export function createAuditNotices(d: { port: InboxPort; owners: () => readonly string[]; clock: () => number }) {
  const publish = (code: string, count: number): void => {
    const at = new Date(d.clock()).toISOString();
    for (const userId of new Set(d.owners())) d.port.publish({ userId, kind: "system", severity: "warning",
      titleKey: "inbox.audit.warning", params: { code, count: Number.isSafeInteger(count) && count >= 0 ? count : 0, at },
      ref: { route: "/logs" }, dedupeKey: `audit:${code}` }, { cooldownMs: HOUR });
  };
  return {
    refused(code: string): void { publish(CODES.has(code) ? code : "audit-unavailable", 1); },
    record(value: unknown): void {
      if (!value || typeof value !== "object") return;
      const row = value as Record<string, unknown>, now = d.clock();
      if (typeof row.at !== "number" || !Number.isSafeInteger(row.at) || row.at < now - HOUR || row.at > now) return;
      if (row.chain === "refused") publish(typeof row.chainReason === "string" && CODES.has(row.chainReason) ? row.chainReason : "audit-unavailable", 1);
      const detail = row.detail && typeof row.detail === "object" ? row.detail as Record<string, unknown> : {};
      const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
      if (row.action === "audit.chain.pending_drained" && count(detail.count)) publish("pending", detail.count);
      if ((row.action === "audit.chain.pending_overflow" || row.action === "audit.chain.pending_drained") && count(detail.dropped)) publish("pending-overflow", detail.dropped);
    },
    observe(health: AuditHealth): void {
      if (health.state === "refusing") publish(CODES.has(health.reason ?? "") ? health.reason! : "audit-unavailable", 1);
      if (health.pendingLines > 0) publish("pending", health.pendingLines);
      if (health.pendingDropped > 0) publish("pending-overflow", health.pendingDropped);
    },
  };
}

/** Incrementally consume complete audit.log rows, including queues drained between health samples. Read-only, bounded IO per tick. */
export function createAuditNoticeLogReader(o: { file: string; consume: (row: unknown) => void; onOversize?: () => void }) {
  let offset = 0, identity = "", pending = Buffer.alloc(0), discarding = false;
  return { scan(): boolean {
    let fd: number;
    try { fd = openSync(o.file, "r"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
    try {
      const st = fstatSync(fd), key = `${st.dev}:${st.ino}`;
      if (key !== identity || st.size < offset) { identity = key; offset = 0; pending = Buffer.alloc(0); discarding = false; }
      const size = Math.min(1024 * 1024, st.size - offset); if (size <= 0) return false;
      const buffer = Buffer.alloc(size), read = readSync(fd, buffer, 0, size, offset); offset += read;
      const data = Buffer.concat([pending, buffer.subarray(0, read)]); let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        if (discarding) discarding = false;
        else {
          let row: unknown;
          try { row = JSON.parse(data.subarray(start, end).toString("utf8")); } catch { start = end + 1; continue; }
          o.consume(row);
        }
        start = end + 1;
      }
      pending = Buffer.from(data.subarray(start));
      if (pending.length > 8 * 1024 * 1024) { pending = Buffer.alloc(0); discarding = true; o.onOversize?.(); }
      return fstatSync(fd).size > offset;
    } finally { closeSync(fd); }
  } };
}
