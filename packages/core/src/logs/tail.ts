// logs.tail: a polling follower over the live files of the selected chains. No fs.watch (unreliable across platforms
// and network homes); a poll reads what was appended since the last one, only complete lines, and survives rotation:
// when a live file's identity changes (or it shrinks) the remainder of the renamed file is read first, then the new
// file from its start. Records leave through the `logs.lines` notification, redacted like logs.query's.
import { randomUUID } from "node:crypto";
import { RpcError } from "../rpc/errors.ts";
import { listChains, openRegular, type LogChain, type OpenLog } from "./files.ts";
import { MAX_LINE_BYTES, completeEnd } from "./line-io.ts";
import { parseLine, toRecord, type LogRecord } from "./normalize.ts";
import { chainSelected, compileFilter, levelPasses, textPasses, type CompiledFilter, type LogFilter } from "./query.ts";
import type { Redactor } from "./redact.ts";

/** What logs.tail accepts as a filter: no time range (a tail is "from now on"). */
export type TailFilter = Omit<LogFilter, "since" | "until">;

export interface LogLines {
  tailId: string;
  records: LogRecord[];
  /** Unparsable or oversize lines seen since the last notification. */
  corruptLines: number;
  /** Records dropped because a poll produced more than the per-poll cap (the newest are kept). */
  dropped: number;
  /** A live file was rotated or truncated; `gap` is true when part of it could not be recovered. */
  rotated?: { gap: boolean };
  /** The tail is over: its ttl ran out, or the core is shutting down. */
  ended?: "expired" | "shutdown";
}

export const DEFAULT_TAIL_TTL_MS = 5 * 60_000;
export const MAX_TAIL_TTL_MS = 60 * 60_000;
export const MAX_TAILS = 4;
export const POLL_MS = 500;
const MAX_BYTES_PER_FILE_POLL = 1024 * 1024;
const MAX_RECORDS_PER_POLL = 1000;
const BATCH = 200;

export interface TailDeps {
  dir: string;
  redactor: Redactor;
  notify: (method: "logs.lines", params: LogLines, opts: { optIn: true }) => void;
  now: () => number;
  /** One-shot timer; returns its cancel. Injected so tests use a fake clock. */
  setTimer: (fn: () => void, ms: number) => () => void;
  pollMs?: number;
  maxTails?: number;
  newId?: () => string;
  /** Called for a failure that a poll swallowed (it never takes the core down). */
  onError?: (e: unknown) => void;
}
export interface TailService {
  start(filter: TailFilter, o?: { ttlMs?: number }): Promise<{ tailId: string; ttlMs: number; expiresAt: string }>;
  stop(tailId: string): boolean;
  stopAll(reason?: "shutdown"): void;
  /** One read pass over every tail (the timer calls it; tests call it directly). */
  poll(): Promise<void>;
  active(): number;
}

interface Track { identity: string; offset: number; carry: Buffer; discarding: boolean }
interface Tail { id: string; filter: CompiledFilter; expiresAt: number; tracks: Map<string, Track> }

export function createTailService(d: TailDeps): TailService {
  const tails = new Map<string, Tail>();
  const pollMs = d.pollMs ?? POLL_MS;
  const maxTails = d.maxTails ?? MAX_TAILS;
  let cancelTimer: (() => void) | null = null;
  let running: Promise<void> | null = null;

  const schedule = (): void => {
    if (cancelTimer || tails.size === 0) return;
    cancelTimer = d.setTimer(() => { cancelTimer = null; void poll(); }, pollMs);
  };
  const unschedule = (): void => { if (tails.size === 0 && cancelTimer) { cancelTimer(); cancelTimer = null; } };

  async function start(filterIn: TailFilter, o: { ttlMs?: number } = {}): Promise<{ tailId: string; ttlMs: number; expiresAt: string }> {
    const filter = compileFilter(filterIn);
    const ttlMs = o.ttlMs ?? DEFAULT_TAIL_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TAIL_TTL_MS) throw new RpcError("E_INVALID_PARAMS", `invalid log filter: ttlMs must be 1000 to ${MAX_TAIL_TTL_MS}`, { reason: "ttl-invalid" });
    if (tails.size >= maxTails) throw new RpcError("E_CONFLICT", `at most ${maxTails} log tails at a time`, { reason: "too-many-tails" });
    const tail: Tail = { id: (d.newId ?? randomUUID)(), filter, expiresAt: d.now() + ttlMs, tracks: new Map() };
    // Start at the end of every live file now ("from now on"); a half line at the end is read once it is complete.
    for (const chain of listChains(d.dir)) {
      if (!chainSelected(chain, filter)) continue;
      const f = await openRegular(chain.base);
      if (!f) continue;
      try { tail.tracks.set(chain.id, { identity: f.identity, offset: await completeEnd(f.fh, f.size), carry: Buffer.alloc(0), discarding: false }); } finally { await f.close(); }
    }
    tails.set(tail.id, tail);
    schedule();
    return { tailId: tail.id, ttlMs, expiresAt: new Date(tail.expiresAt).toISOString() };
  }

  function stop(tailId: string): boolean {
    const had = tails.delete(tailId);
    unschedule();
    return had;
  }

  function stopAll(reason: "shutdown" = "shutdown"): void {
    for (const t of tails.values()) d.notify("logs.lines", { tailId: t.id, records: [], corruptLines: 0, dropped: 0, ended: reason }, { optIn: true });
    tails.clear();
    unschedule();
  }

  /** Reads `[track.offset, size)` of an open file in bounded steps, returns the complete lines. `final`: the file is
   *  finished (rotated away), so a last line without a newline counts as complete. */
  async function readNew(f: OpenLog, track: Track, final: boolean, lines: string[], st: { corrupt: number }): Promise<void> {
    let budget = MAX_BYTES_PER_FILE_POLL;
    while (budget > 0 && track.offset < f.size) {
      const n = Math.min(budget, f.size - track.offset, 64 * 1024);
      const buf = Buffer.allocUnsafe(n);
      const { bytesRead } = await f.fh.read(buf, 0, n, track.offset);
      if (bytesRead === 0) break;
      track.offset += bytesRead;
      budget -= bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      for (;;) {
        const nl = chunk.indexOf(0x0a);
        if (nl < 0) {
          if (!track.discarding) {
            track.carry = Buffer.concat([track.carry, chunk]);
            if (track.carry.length > MAX_LINE_BYTES) { st.corrupt++; track.carry = Buffer.alloc(0); track.discarding = true; }
          }
          break;
        }
        const head = chunk.subarray(0, nl);
        chunk = chunk.subarray(nl + 1);
        if (track.discarding) { track.discarding = false; continue; }
        let line = Buffer.concat([track.carry, head]);
        track.carry = Buffer.alloc(0);
        if (line.length > MAX_LINE_BYTES) { st.corrupt++; continue; }
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        if (line.length > 0) lines.push(line.toString("utf8"));
      }
    }
    if (final && track.offset >= f.size && !track.discarding && track.carry.length > 0) { lines.push(track.carry.toString("utf8")); track.carry = Buffer.alloc(0); }
  }

  async function oldFileOf(chain: LogChain, identity: string): Promise<OpenLog | null> {
    for (const p of chain.files) {
      if (p === chain.base) continue;
      const o = await openRegular(p);
      if (!o) continue;
      if (o.identity === identity && !identity.endsWith(":0")) return o;
      await o.close();
    }
    return null;
  }

  async function pollTail(t: Tail, out: { records: LogRecord[]; corrupt: number; rotated: { gap: boolean } | null }): Promise<void> {
    const lines: Array<{ text: string; chain: LogChain }> = [];
    const st = { corrupt: 0 };
    for (const chain of listChains(d.dir)) {
      if (!chainSelected(chain, t.filter)) continue;
      const live = await openRegular(chain.base);
      let track = t.tracks.get(chain.id);
      try {
        if (!track) {
          // A chain that appeared after the tail started (a new module's file): everything in it is new.
          if (!live) continue;
          track = { identity: live.identity, offset: 0, carry: Buffer.alloc(0), discarding: false };
          t.tracks.set(chain.id, track);
        } else if (live && (track.identity !== live.identity || live.size < track.offset)) {
          // Rotation (rename) or truncation: finish the old file, then start the new one from 0.
          const old = live.size < track.offset && track.identity === live.identity ? null : await oldFileOf(chain, track.identity);
          const gap = old === null;
          if (old) {
            const buf: string[] = [];
            try { await readNew(old, track, true, buf, st); } finally { await old.close(); }
            for (const text of buf) lines.push({ text, chain });
          }
          out.rotated = { gap: gap || (out.rotated?.gap ?? false) };
          track = { identity: live.identity, offset: 0, carry: Buffer.alloc(0), discarding: false };
          t.tracks.set(chain.id, track);
        }
        if (!live) continue;
        const buf: string[] = [];
        await readNew(live, track, false, buf, st);
        for (const text of buf) lines.push({ text, chain });
      } finally { await live?.close(); }
    }
    out.corrupt += st.corrupt;
    for (const { text, chain } of lines) {
      const parsed = parseLine(text, chain.stream);
      if (!parsed) { out.corrupt++; continue; }
      if (!levelPasses(parsed.level, t.filter)) continue;
      const rec = toRecord(parsed, { key: chain.key, stream: chain.stream }, d.redactor);
      if (!textPasses(rec, t.filter)) continue;
      out.records.push(rec);
    }
  }

  async function runPoll(): Promise<void> {
    for (const t of [...tails.values()]) {
      if (!tails.has(t.id)) continue;
      if (d.now() >= t.expiresAt) {
        tails.delete(t.id);
        d.notify("logs.lines", { tailId: t.id, records: [], corruptLines: 0, dropped: 0, ended: "expired" }, { optIn: true });
        continue;
      }
      const out: { records: LogRecord[]; corrupt: number; rotated: { gap: boolean } | null } = { records: [], corrupt: 0, rotated: null };
      try { await pollTail(t, out); } catch (e) { d.onError?.(e); continue; }
      if (!tails.has(t.id)) continue; // stopped while reading
      out.records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      let dropped = 0;
      if (out.records.length > MAX_RECORDS_PER_POLL) { dropped = out.records.length - MAX_RECORDS_PER_POLL; out.records = out.records.slice(dropped); }
      if (out.records.length === 0 && out.corrupt === 0 && !out.rotated && dropped === 0) continue;
      for (let i = 0; i === 0 || i < out.records.length; i += BATCH) {
        const first = i === 0;
        d.notify("logs.lines", {
          tailId: t.id, records: out.records.slice(i, i + BATCH), corruptLines: first ? out.corrupt : 0, dropped: first ? dropped : 0,
          ...(first && out.rotated ? { rotated: out.rotated } : {}),
        }, { optIn: true });
      }
    }
  }

  function poll(): Promise<void> {
    if (running) return running;
    running = runPoll().catch((e) => d.onError?.(e)).finally(() => { running = null; unschedule(); schedule(); });
    return running;
  }

  return { start, stop, stopAll, poll, active: () => tails.size };
}
