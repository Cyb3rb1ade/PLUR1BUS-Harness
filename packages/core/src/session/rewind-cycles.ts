/** D120 Q13: count successful edits followed by failed checks on the active transcript, never agent claims. */
import type { EventRecord } from "./types.ts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Read a stored dispatcher envelope; malformed/plain output provides no trustworthy result facts. */
export function rewindResult(event: EventRecord): Record<string, unknown> {
  let output: unknown = event.data.output;
  if (typeof output === "string") {
    try { output = JSON.parse(output); } catch { return {}; }
  }
  const envelope = record(output);
  return { ...record(envelope.value ?? envelope),
    ...(typeof envelope.isError === "boolean" ? { isError: envelope.isError } : {}) };
}

function isCheck(call: EventRecord): boolean {
  if (["code.check", "coding_complete"].includes(String(call.data.name))) return true;
  if (call.data.name !== "exec.run") return false;
  const argv = record(call.data.args).argv;
  return Array.isArray(argv) && argv.some(arg => typeof arg === "string"
    && /^(?:--test(?:=.*)?|test(?::[^\s]+)?|pytest|vitest|jest|mocha|ctest|go-test)$/.test(arg));
}

/** N=3 is fixed by Q13. Extra checks without a new successful edit never increment the streak. */
export function failedEditCycles(events: readonly EventRecord[]): {
  failedCycles: number; fromTurnId: string | null; lastCheckSeq: number; pendingEdit: boolean;
} {
  const calls = new Map<string, { event: EventRecord; afterWrite: boolean }>();
  let dirty = false, writeTurn: string | null = null, fromTurnId: string | null = null;
  let failedCycles = 0, lastCheckSeq = 0;
  for (const event of events) {
    const key = `${event.turnId}:${String(event.data.id)}`;
    if (event.type === "tool.call") {
      calls.set(key, { event, afterWrite: dirty });
      continue;
    }
    if (event.type !== "tool.result") continue;
    const pending = calls.get(key);
    if (!pending) continue;
    calls.delete(key);
    const value = rewindResult(event);
    const failed = event.data.isError === true || value.isError === true || value.ok === false
      || (typeof value.exitCode === "number" && value.exitCode !== 0);
    if (["file.edit", "file.write"].includes(String(pending.event.data.name)) && !failed
      && (value.isError === false || event.data.isError === false)) {
      dirty = true;
      writeTurn ??= event.turnId;
    } else if (isCheck(pending.event)) {
      lastCheckSeq = event.seq;
      if (!failed && (value.ok === true || value.exitCode === 0)) {
        failedCycles = 0;
        fromTurnId = null;
        dirty = false;
        writeTurn = null;
      } else if (failed && dirty && pending.afterWrite) {
        failedCycles++;
        fromTurnId ??= writeTurn;
        dirty = false;
        writeTurn = null;
      }
    }
  }
  return { failedCycles, fromTurnId, lastCheckSeq, pendingEdit: dirty };
}
