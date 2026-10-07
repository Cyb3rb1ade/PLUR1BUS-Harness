// The live tail loop over logs.tail (a long-poll RPC; there is no log event on SSE). The first call (no cursor, limit 1) only
// anchors the cursor; later calls pass the cursor back with waitMs. Every call is abortable. Failures back off 1 s, 2 s, 4 s ...
// up to 30 s; a missing method or a denied role ends the loop; a cursor the server no longer accepts re-anchors.
import type { LogPage, LogRecord } from "./model.ts";

export type TailState = "live" | "retrying" | "unavailable" | "forbidden";
export type TailFailure = "abort" | "forbidden" | "unavailable" | "reanchor" | "retry";

export type TailOptions = {
  call: (cursor: string | null, signal: AbortSignal) => Promise<LogPage>;
  /** `anchor` is true for the first page of a (re-)anchor: its records may already be on screen. Records are oldest first. */
  onRecords: (records: LogRecord[], anchor: boolean) => void;
  onState: (state: TailState) => void;
  classify: (e: unknown) => TailFailure;
  signal: AbortSignal;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Minimum gap between two calls that returned nothing (guards against a server that ignores waitMs). */
  idleMs?: number;
  now?: () => number;
};

export const backoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** attempt);

export async function runTail(o: TailOptions): Promise<void> {
  const idle = o.idleMs ?? 500;
  const now = o.now ?? Date.now;
  let cursor: string | null = null, attempt = 0, anchor = true;
  while (!o.signal.aborted) {
    const started = now();
    try {
      const page = await o.call(cursor, o.signal);
      if (o.signal.aborted) return;
      if (attempt > 0 || anchor) o.onState("live");
      attempt = 0;
      const wasAnchor = anchor;
      if (page.nextCursor !== null) cursor = page.nextCursor;
      anchor = cursor === null;
      if (page.records.length > 0 || wasAnchor) o.onRecords(page.records, wasAnchor);
      if (page.records.length === 0 && now() - started < idle) await o.sleep(idle - (now() - started), o.signal);
    } catch (e) {
      if (o.signal.aborted) return;
      const kind = o.classify(e);
      if (kind === "abort") return;
      if (kind === "forbidden" || kind === "unavailable") { o.onState(kind); return; }
      if (kind === "reanchor") { cursor = null; anchor = true; continue; }
      o.onState("retrying");
      await o.sleep(backoffMs(attempt++), o.signal);
    }
  }
}
