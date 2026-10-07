import type { AuditSink } from "../rbac/audit.ts";

/** Writes to `primary` first, then to `copy`. RULING B5-4: the legacy `logs/audit.log` stays the primary record, so a
 *  failure of the chain copy never hides an event from it, but both failures surface: `append` throws when either one
 *  could not record the event (callers that must not act unrecorded rely on that). */
export function teeAudit(primary: AuditSink, copy: AuditSink): AuditSink {
  return {
    append(e) {
      let first: unknown, failed = false;
      try { primary.append(e); } catch (err) { failed = true; first = err; }
      try { copy.append(e); } catch (err) { if (!failed) throw err; }
      if (failed) throw first;
    },
  };
}
