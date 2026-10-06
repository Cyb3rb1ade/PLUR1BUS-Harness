// Audit sink for RBAC events. The line shape is the five-key one `crates/plur1bus/src/audit.rs` writes to
// `logs/audit.log`: `{ at, actor: { user, host }, action, target, detail }`, append-only, private to the user.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEvent {
  at: number;
  actor: { user: string; host: string };
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

/** `append` throws when the event could not be recorded; callers that must not act unrecorded rely on it. */
export interface AuditSink { append(event: AuditEvent): void }

export interface MemoryAuditSink extends AuditSink { readonly events: AuditEvent[] }

export function memoryAuditSink(): MemoryAuditSink {
  const events: AuditEvent[] = [];
  return { events, append: (e) => { events.push(structuredClone(e)); } };
}

export interface JsonlAuditOptions {
  /** Applied after the file exists (Windows ACL via the host's `securePath`); POSIX gets 0600 either way. */
  securePath?: (path: string) => void;
}

export function createJsonlAuditSink(path: string, o: JsonlAuditOptions = {}): AuditSink {
  return {
    append(e) {
      const line = `${JSON.stringify({ at: e.at, actor: e.actor, action: e.action, target: e.target, detail: e.detail })}\n`;
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "a", 0o600);
      try {
        if (process.platform !== "win32") chmodSync(path, 0o600); // an existing file may be looser
        o.securePath?.(path);
        writeSync(fd, line); // one write on an O_APPEND handle: a crash never leaves half a line in the middle
        fsyncSync(fd);
      } finally { closeSync(fd); }
    },
  };
}
