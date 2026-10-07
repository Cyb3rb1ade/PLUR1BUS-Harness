// Activity feed data: `logs.query` per stream (cursor paged) and `audit.verify`. Loading is split from the view so each part
// degrades on its own: one stream failing leaves the other's entries, a failed verify leaves the feed.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { failureOf, getApi, type Failure } from "../../common/load.ts";
import { toEntries, mergeEntries, type ActivityEntry, type LogRecord } from "./model.ts";

export const PAGE_SIZE = 100;
export type Stream = "audit" | "diagnostic";
type LogPage = { records: LogRecord[]; nextCursor: string | null };

export async function fetchStream(stream: Stream, cursor: string | null, signal?: AbortSignal): Promise<{ entries: ActivityEntry[]; next: string | null }> {
  const params = { stream, order: "desc", limit: PAGE_SIZE, ...(stream === "diagnostic" ? { text: "scheduler.run." } : {}), ...(cursor ? { cursor } : {}) };
  const page = (await getApi().rpc("logs.query", params, { write: false, ...(signal ? { signal } : {}) })) as unknown as LogPage;
  return { entries: toEntries(page.records), next: page.nextCursor ?? null };
}

export type FeedState =
  | { status: "loading" }
  | { status: "fail"; failure: Failure }
  | { status: "ok"; entries: ActivityEntry[]; cursors: Record<Stream, string | null>; failed: Stream[]; busy: boolean; moreFailed: boolean };

const STREAMS: Stream[] = ["audit", "diagnostic"];
const RANK: Record<Failure["kind"], number> = { forbidden: 0, unavailable: 1, "not-found": 2, error: 3 };

/** Loads the first page of both streams; `more()` loads the next page of every stream that has one. */
export function useFeed(enabled: boolean): { state: FeedState; reload: () => void; more: () => void } {
  const [state, setState] = useState<FeedState>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const live = useRef(state);
  live.current = state;
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const c = new AbortController();
    ctl.current = c;
    setState({ status: "loading" });
    void Promise.allSettled(STREAMS.map((s) => fetchStream(s, null, c.signal))).then((rs) => {
      if (c.signal.aborted) return;
      const failures = rs.flatMap((r) => (r.status === "rejected" ? [failureOf(r.reason)] : []));
      if (failures.length === rs.length) { setState({ status: "fail", failure: failures.sort((a, b) => RANK[a.kind] - RANK[b.kind])[0]! }); return; }
      let entries: ActivityEntry[] = [];
      const cursors: Record<Stream, string | null> = { audit: null, diagnostic: null };
      const failed: Stream[] = [];
      rs.forEach((r, i) => {
        const s = STREAMS[i]!;
        if (r.status === "fulfilled") { entries = mergeEntries(entries, r.value.entries); cursors[s] = r.value.next; } else failed.push(s);
      });
      setState({ status: "ok", entries, cursors, failed, busy: false, moreFailed: false });
    });
    return () => { c.abort(); };
  }, [enabled, tick]);

  const more = useCallback(() => {
    const cur = live.current;
    if (cur.status !== "ok" || cur.busy) return;
    const todo = STREAMS.filter((s) => cur.cursors[s] !== null);
    if (todo.length === 0) return;
    setState({ ...cur, busy: true, moreFailed: false });
    const c = ctl.current;
    void Promise.allSettled(todo.map((s) => fetchStream(s, cur.cursors[s], c?.signal))).then((rs) => {
      if (c?.signal.aborted) return;
      const now = live.current;
      if (now.status !== "ok") return;
      let entries = now.entries;
      const cursors = { ...now.cursors };
      let moreFailed = false;
      rs.forEach((r, i) => {
        if (r.status === "fulfilled") { entries = mergeEntries(entries, r.value.entries); cursors[todo[i]!] = r.value.next; } else moreFailed = true;
      });
      setState({ ...now, entries, cursors, busy: false, moreFailed });
    });
  }, []);

  return { state, reload: () => { setTick((n) => n + 1); }, more };
}

export type VerifyResult = { ok: boolean; records: number; files: number; lastSeq: number; findingsTotal: number; findings: { code: string; file: string; line: number | null; seq: number | null }[] };
export type VerifyState =
  | { status: "checking" }
  | { status: "done"; result: VerifyResult; at: number }
  | { status: "fail"; kind: Failure["kind"]; at: number };

/** `audit.verify` on mount and on `run()`. The RPC has no check time of its own, so `at` is when this browser got the answer. */
export function useVerify(enabled: boolean, clock: () => number): { state: VerifyState; run: () => void } {
  const [state, setState] = useState<VerifyState>({ status: "checking" });
  const [tick, setTick] = useState(0);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  useEffect(() => {
    if (!enabled) return;
    const c = new AbortController();
    setState({ status: "checking" });
    getApi().rpc("audit.verify", {}, { write: false, signal: c.signal }).then(
      (r) => { if (!c.signal.aborted) setState({ status: "done", result: r as unknown as VerifyResult, at: clockRef.current() }); },
      (e: unknown) => { if (!c.signal.aborted && (e as { kind?: string }).kind !== "aborted") setState({ status: "fail", kind: failureOf(e).kind, at: clockRef.current() }); },
    );
    return () => { c.abort(); };
  }, [enabled, tick]);
  return { state, run: () => { setTick((n) => n + 1); } };
}
