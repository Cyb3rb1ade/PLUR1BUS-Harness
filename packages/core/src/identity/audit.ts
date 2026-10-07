import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import type { AuditEvent } from "./service.ts";

/**
 * Appends to `logs/audit.log` in the line shape `crates/plur1bus/src/audit.rs` writes:
 * `{ at, actor: { user, host }, action, target, detail }`, one JSON line, append-only, private to the user.
 * An event without an actor (a claim relayed by a channel adapter) is attributed to the core itself.
 * No event carries a pairing code: the service never hands one to the sink.
 */
export function createAuditWriter(o: { file: string; securePath: (p: string) => void; clock: () => number }): (e: AuditEvent) => void {
  let secured = false;
  return (e) => {
    if (!secured) {
      mkdirSync(path.dirname(o.file), { recursive: true, mode: 0o700 });
      closeSync(openSync(o.file, "a", 0o600));
      o.securePath(o.file);
      secured = true;
    }
    const line = JSON.stringify({ at: o.clock(), actor: e.actor ?? { user: "core", host: "core" }, action: e.action, target: e.target, detail: e.detail });
    appendFileSync(o.file, line + "\n", { mode: 0o600 });
  };
}
