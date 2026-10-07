// Data hook of the log viewer: the first logs.query page, "Load older" pages, and the live tail on top of them. Every call is
// abortable; changing the filters (or Reload) aborts the previous query and tail. New lines go to the list, or to a bounded buffer
// while paused. Rows get a client id so the list can keep its place when lines are prepended.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getApi } from "../../../api/shared.ts";
import { failureOf, type Failure } from "../../common/load.ts";
import {
  bufferAppend, buildQuery, liveEligible, recordKey, ROW_CAP, tailParams, TAIL_BUFFER_MAX,
  type BuildError, type Filters, type LogPage, type LogRecord, type QueryParams,
} from "./model.ts";
import { runTail, type TailFailure, type TailState } from "./tail.ts";

export type Row = { id: number; rec: LogRecord };
export type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "fail"; failure: Failure };
export type TailView = "off" | "starting" | TailState;
export type MoreState = "idle" | "loading" | "error";

export type LogData = {
  phase: Phase;
  rows: readonly Row[];
  hasMore: boolean;
  more: MoreState;
  loadMore: () => void;
  corrupt: number;
  truncated: boolean;
  trimmed: boolean;
  tail: TailView;
  /** Lines received while paused, and how many of them the bounded buffer had to drop. */
  buffered: number;
  dropped: number;
  buildError: BuildError | null;
};

let seq = 0;
const toRow = (rec: LogRecord): Row => ({ id: ++seq, rec });
const isAbort = (e: unknown): boolean => (e as { kind?: string } | null)?.kind === "aborted";
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

function classify(e: unknown): TailFailure {
  if (isAbort(e)) return "abort";
  const reason = (e as { reason?: unknown } | null)?.reason;
  if (reason === "bad-cursor" || reason === "cursor-mismatch") return "reanchor";
  const k = failureOf(e).kind;
  return k === "forbidden" || k === "unavailable" ? k : "retry";
}

export function useLogData(filters: Filters, reload: number, paused: boolean): LogData {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState<MoreState>("idle");
  const [meta, setMeta] = useState({ corrupt: 0, truncated: false, trimmed: false });
  const [tail, setTail] = useState<TailView>("off");
  const [buf, setBuf] = useState({ n: 0, dropped: 0 });
  const [buildError, setBuildError] = useState<BuildError | null>(null);
  const [gen, setGen] = useState(0);

  const rowsRef = useRef<readonly Row[]>([]);
  const queryRef = useRef<QueryParams | null>(null);
  const pausedRef = useRef(paused);
  const bufRef = useRef<{ rows: Row[]; dropped: number }>({ rows: [], dropped: 0 });
  const moreCtl = useRef<AbortController | null>(null);
  pausedRef.current = paused;

  const commit = useCallback((next: readonly Row[]): void => { rowsRef.current = next; setRows(next); }, []);
  const flush = useCallback((): void => {
    const b = bufRef.current;
    if (b.rows.length === 0 && b.dropped === 0) return;
    bufRef.current = { rows: [], dropped: 0 };
    setBuf({ n: 0, dropped: 0 });
    const merged = [...b.rows.slice().reverse(), ...rowsRef.current];
    if (merged.length > ROW_CAP) { setMeta((m) => ({ ...m, trimmed: true })); commit(merged.slice(0, ROW_CAP)); } else commit(merged);
  }, [commit]);

  // Resume: show what was collected while paused.
  useEffect(() => { if (!paused) flush(); }, [paused, flush]);

  // The query.
  useEffect(() => {
    const ctl = new AbortController();
    moreCtl.current?.abort();
    const built = buildQuery(filters, Date.now());
    if (!built.ok) { setBuildError(built.error); return; }
    setBuildError(null);
    queryRef.current = built.params;
    setPhase({ kind: "loading" });
    setTail("off");
    setMore("idle");
    bufRef.current = { rows: [], dropped: 0 };
    setBuf({ n: 0, dropped: 0 });
    setGen(0);
    getApi().rpc("logs.query", built.params as never, { write: false, signal: ctl.signal }).then((res) => {
      if (ctl.signal.aborted) return;
      const page = res as unknown as LogPage;
      commit(page.records.map(toRow));
      setCursor(page.nextCursor);
      setMeta({ corrupt: page.corrupt, truncated: page.truncated, trimmed: false });
      setPhase({ kind: "ready" });
      setGen((g) => g + 1);
    }, (e: unknown) => {
      if (ctl.signal.aborted || isAbort(e)) return;
      setPhase({ kind: "fail", failure: failureOf(e) });
    });
    return () => { ctl.abort(); };
  }, [filters, reload]);

  // The tail, once a query has succeeded.
  const eligible = liveEligible(filters);
  useEffect(() => {
    const q = queryRef.current;
    if (gen === 0 || !q) return;
    if (!eligible) { setTail("off"); return; }
    const ctl = new AbortController();
    setTail("starting");
    void runTail({
      signal: ctl.signal, sleep, classify,
      call: (c, signal) => getApi().rpc("logs.tail", tailParams(q, c === null ? { limit: 1 } : { cursor: c, waitMs: 15_000, limit: 1000 }) as never, { write: false, signal }) as unknown as Promise<LogPage>,
      onState: (s) => { if (!ctl.signal.aborted) setTail(s); },
      onRecords: (records, anchor) => {
        if (ctl.signal.aborted) return;
        let fresh = records;
        if (anchor) {
          const known = new Set(rowsRef.current.slice(0, 50).map((r) => recordKey(r.rec)));
          for (const r of bufRef.current.rows) known.add(recordKey(r.rec));
          fresh = records.filter((r) => !known.has(recordKey(r)));
        }
        if (fresh.length === 0) return;
        const incoming = fresh.map(toRow);
        if (pausedRef.current) {
          const r = bufferAppend(bufRef.current.rows, incoming, TAIL_BUFFER_MAX);
          bufRef.current = { rows: r.buf, dropped: bufRef.current.dropped + r.dropped };
          setBuf({ n: r.buf.length, dropped: bufRef.current.dropped });
          return;
        }
        const merged = [...incoming.reverse(), ...rowsRef.current];
        if (merged.length > ROW_CAP) { setMeta((m) => ({ ...m, trimmed: true })); commit(merged.slice(0, ROW_CAP)); } else commit(merged);
      },
    });
    return () => { ctl.abort(); };
  }, [gen, eligible]);

  const loadMore = useCallback((): void => {
    const q = queryRef.current;
    if (!q || cursor === null) return;
    moreCtl.current?.abort();
    const ctl = new AbortController();
    moreCtl.current = ctl;
    setMore("loading");
    getApi().rpc("logs.query", { ...q, cursor } as never, { write: false, signal: ctl.signal }).then((res) => {
      if (ctl.signal.aborted) return;
      const page = res as unknown as LogPage;
      commit([...rowsRef.current, ...page.records.map(toRow)]);
      setCursor(page.nextCursor);
      setMeta((m) => ({ ...m, corrupt: m.corrupt + page.corrupt, truncated: page.truncated }));
      setMore("idle");
    }, (e: unknown) => { if (!ctl.signal.aborted && !isAbort(e)) setMore("error"); });
  }, [cursor, commit]);

  return { phase, rows, hasMore: cursor !== null, more, loadMore, corrupt: meta.corrupt, truncated: meta.truncated, trimmed: meta.trimmed, tail, buffered: buf.n, dropped: buf.dropped, buildError };
}
