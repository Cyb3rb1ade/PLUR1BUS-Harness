import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { validateJournalLine, type JournalLine } from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "./agents.ts";
import type { HarnessLogger } from "./logger.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "./principal.ts";

const NL = 0x0a;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; // rpc.schema.json $defs/AgentId; it becomes a file name, so it is checked here too

/** One physical line per call. A file that ends without `\n` (a writer that crashed mid-line) gets one first, so this
 *  line never glues onto the fragment and is lost with it. */
export function appendJournalLine(dir: string, line: JournalLine): void {
  if (typeof line.agentId !== "string" || !AGENT_ID.test(line.agentId)) throw new Error("journal: invalid agentId in journal line");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, `${line.agentId}.jsonl`), "a+", 0o600);
  try {
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const gluing = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== NL;
    writeSync(fd, `${gluing ? "\n" : ""}${JSON.stringify(line)}\n`); // one write on an O_APPEND handle
  } finally { closeSync(fd); }
}

const REPLAYING_SUFFIX = /\.jsonl\.replaying-\d+$/;

/** A replay reads a journal file line by line and holds at most this many bytes of one line (twice the RPC line limit
 *  of 4 MiB, which bounds every line the CLI journals). A longer line is not read into memory: it counts as defective
 *  (kept, never replayed) and is logged once per replay. */
export const JOURNAL_LINE_MAX_BYTES = 8 * 1024 * 1024;

/** `journalBacklog` stops counting at either bound and reports what it counted up to there (the engine waits at most
 *  50 ms for it): at most this many lines … */
export const JOURNAL_BACKLOG_MAX_ENTRIES = 100_000;
/** … and at most this many bytes read across all journal files. */
export const JOURNAL_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;
/** Both writers (the CLI's serde struct and `appendJournalLine`) emit `v`, `id`, `at` first; anything else is parsed. */
const AT_PREFIX = /^\{"v":1,"id":"[^"\\]*","at":(\d+)[,}]/;
const AT_PREFIX_BYTES = 128;

/** `at` of one complete line (`buf[start, end)`, without its `\n`): the fixed prefix when it matches, else a parse. */
function atOf(buf: Buffer, start: number, end: number): number | null {
  const m = AT_PREFIX.exec(buf.toString("utf8", start, Math.min(end, start + AT_PREFIX_BYTES)));
  if (m) return Number(m[1]);
  try {
    const at = (JSON.parse(buf.toString("utf8", start, end)) as { at?: unknown } | null)?.at;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch { return null; }
}

const isBlank = (buf: Buffer, start: number, end: number): boolean => {
  for (let k = start; k < end; k++) { const b = buf[k]!; if (b !== 0x20 && b !== 0x09 && b !== 0x0d) return false; }
  return true;
};

/** Up to `max` bytes from the start of `path`; null when it vanished (a replay renamed or removed it meanwhile). */
function readHead(path: string, max: number): Buffer | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try {
    const buf = Buffer.allocUnsafe(Math.min(max, fstatSync(fd).size));
    let n = 0;
    while (n < buf.length) { const r = readSync(fd, buf, n, buf.length - n, n); if (r === 0) break; n += r; }
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

/** The host capability `journalBacklog` (E4, HostCapabilities): complete (newline-terminated, non-blank) lines across
 *  every `<agent>.jsonl` and every `*.jsonl.replaying-*` (a replay in progress, or one a killed core left behind), and
 *  the smallest `at` among them. Sync and bounded by JOURNAL_BACKLOG_MAX_ENTRIES lines and JOURNAL_BACKLOG_MAX_BYTES
 *  read; past either it reports the count up to the bound. A file renamed or removed between the listing and the read
 *  (a replay starting or finishing) is skipped. */
export function journalBacklog(dir: string): { entries: number; oldestAt: number | null } {
  let entries = 0; let oldestAt: number | null = null; let budget = JOURNAL_BACKLOG_MAX_BYTES;
  let files: string[];
  try { files = readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { entries, oldestAt }; throw e; }
  for (const f of files.sort()) {
    if (!f.endsWith(".jsonl") && !REPLAYING_SUFFIX.test(f)) continue;
    if (budget <= 0) break;
    const buf = readHead(join(dir, f), budget);
    if (!buf) continue;
    budget -= buf.length;
    // Only `\n`-terminated lines count: the bytes after the last one are a torn tail (or the byte budget's cut).
    for (let start = 0, nl = buf.indexOf(NL); nl !== -1; start = nl + 1, nl = buf.indexOf(NL, start)) {
      if (isBlank(buf, start, nl)) continue;
      entries += 1;
      const at = atOf(buf, start, nl);
      if (at !== null && (oldestAt === null || at < oldestAt)) oldestAt = at;
      if (entries >= JOURNAL_BACKLOG_MAX_ENTRIES) return { entries, oldestAt };
    }
  }
  return { entries, oldestAt };
}

/** A line that goes back into the journal: its text, or (a line past the bound, or the rest of a file after an abort)
 *  the byte range `[start, end)` of the `.replaying-*` file, copied back in pieces without ever being held. */
type KeptLine = { text: string } | { start: number; end: number };
export type ReplayEngine = Pick<Engine, "capture">;
/** What the background replay (replay.ts) observes. `lineReplayed`: a line was handled (it leaves the journal when its
 *  file is finished); `fileDone`: a `.replaying-*` file was finished (removed, or left after a failure); `cut`: the
 *  abort left lines unreplayed; `abandoned`: a stop gave up waiting (H3B-R2) — the file in progress is then left
 *  exactly as it is (no append-back, no delete) for the next start's recovery. */
export interface ReplayHooks { lineReplayed(): void; fileDone(): void; cut(): void; abandoned(): boolean }
/** `signal` (B2): once aborted, the replay stops between lines — the capture in flight runs to its end under its own
 *  timeout, the rest of the current file is kept without a capture call, no further file is renamed and no further
 *  pass runs. */
export type JournalOpts = { dir: string; agents: AgentRegistry; engine: ReplayEngine; logger: HarnessLogger; clock: () => number; signal?: AbortSignal; hooks?: ReplayHooks; maxLineBytes?: number };

/** Replays state/journal/<agentId>.jsonl at core start (in the background since B2; `o.signal` stops it between
 *  lines, the capture in flight keeps its own 60 s timeout: H3B-R2).
 *
 *  R20: a line leaves the journal only when `capture(...).done` resolves with NO `reason` and
 *  `stored + skipped > 0` (the engine's ok path — a dedup skip with no reason still counts as handled),
 *  or with reason `duplicate-turn` (E4, Q3: the engine already captured this turn; the runId is `journal:<line id>`,
 *  so it is the same at every start and for a line recovered from a leftover `.replaying-*` file). Any other reason, zero counts, or a rejected `done` keeps the line (logged with why), and replay continues
 *  with the next line. Concurrent-append safety: each `<agent>.jsonl` is first atomically renamed to
 *  `<agent>.jsonl.replaying-<pid>` before it is read, so a line the CLI appends to `<agent>.jsonl` while
 *  replay is running lands in a fresh file, never the one being processed. Kept lines (including a torn
 *  or unparseable tail) are always appended back — each followed by its own `\n` — onto whatever
 *  `<agent>.jsonl` holds by the time replay finishes with that file, never overwritten, so nothing the
 *  CLI writes afterward can glue onto a kept fragment. A `*.jsonl.replaying-*` left over from a crashed
 *  replay is recovered the same way, before the regular scan. Round 2: every file is isolated — a rename
 *  or processing failure on one file (e.g. the CLI still holding it open) is logged and skipped, its lines
 *  counted as kept on a best-effort basis, and replay continues with the next file.
 *
 *  The file is read as a stream of lines (64 KiB chunks), so memory is bounded by the longest line replayed, not by the
 *  file. A line longer than `maxLineBytes` (default JOURNAL_LINE_MAX_BYTES) is never held: it is logged, counted as
 *  kept like an unparseable line and written back byte for byte, in its place among the kept lines. */
export async function replayJournal(o: JournalOpts): Promise<{ replayed: number; kept: number }> {
  let replayed = 0; let kept = 0;
  if (!existsSync(o.dir)) return { replayed, kept };

  // Recover any replaying file left over from a crashed prior replay before the regular scan.
  for (const entry of readdirSync(o.dir).filter((f) => REPLAYING_SUFFIX.test(f))) {
    if (o.signal?.aborted) { o.hooks?.cut(); break; } // left in place for the next start's recovery
    const replayingPath = join(o.dir, entry);
    const agentFile = entry.replace(/\.replaying-\d+$/, "");
    const r = await safeProcessReplayingFile(o, replayingPath, agentFile);
    replayed += r.replayed; kept += r.kept;
  }

  for (const file of readdirSync(o.dir).filter((f) => f.endsWith(".jsonl") && !REPLAYING_SUFFIX.test(f))) {
    if (o.signal?.aborted) { o.hooks?.cut(); break; } // not renamed: the lines stay where the CLI wrote them
    const path = join(o.dir, file);
    const replayingPath = `${path}.replaying-${process.pid}`;
    // A leftover under this very name (an abandoned or failed file) still holds lines: renaming over it would destroy them.
    if (existsSync(replayingPath)) {
      o.logger.warn("journal: file skipped this start", { file, err: new Error("a replaying file of this process already exists") });
      kept += countLinesBestEffort(o, path);
      continue;
    }
    try { renameSync(path, replayingPath); }
    catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") continue; // raced away between readdir and rename: nothing left to do
      // A file another process still holds open (e.g. Windows EBUSY/EPERM) must never abort the whole replay.
      o.logger.warn("journal: file skipped this start", { file, err });
      kept += countLinesBestEffort(o, path);
      continue;
    }
    const r = await safeProcessReplayingFile(o, replayingPath, file);
    replayed += r.replayed; kept += r.kept;
  }
  return { replayed, kept };
}

/** I2: replays at start until no line arrived during the last pass. The core runs this in the background once the
 *  RPC server listens and the core is ready (B2, replay.ts): a CLI that failed to connect just before that may
 *  journal into a fresh `<agent>.jsonl` while a pass is running, and a single pass would strand that line until the
 *  next restart. After each pass the lines still on disk are counted: kept lines are appended back, so anything
 *  beyond the pass's own `kept` arrived meanwhile and gets another pass. Bounded by `maxPasses`, so a CLI that keeps
 *  journaling cannot keep the replay running, and by `signal` (no further pass once aborted). `kept` is the on-disk
 *  count after the last pass: `core.status.journalBacklog` when the engine reports no journal. */
export async function drainJournal(o: JournalOpts, maxPasses = 5): Promise<{ replayed: number; kept: number; passes: number }> {
  let replayed = 0;
  for (let passes = 1; ; passes++) {
    const r = await replayJournal(o);
    replayed += r.replayed;
    const onDisk = countJournalLines(o);
    if (onDisk <= r.kept || passes >= maxPasses) return { replayed, kept: onDisk, passes };
    if (o.signal?.aborted) { o.hooks?.cut(); return { replayed, kept: onDisk, passes }; } // lines arrived, no further pass
  }
}

/** Non-empty lines in every `<agent>.jsonl` and leftover `*.jsonl.replaying-*` under the journal dir. */
export function countJournalLines(o: Pick<JournalOpts, "dir" | "logger">): number {
  if (!existsSync(o.dir)) return 0;
  let n = 0;
  for (const f of readdirSync(o.dir)) if (f.endsWith(".jsonl") || REPLAYING_SUFFIX.test(f)) n += countLinesBestEffort(o, join(o.dir, f));
  return n;
}

/** Never throws: a failure processing an already-renamed file is logged and its lines counted as kept
 *  on a best-effort basis, leaving the `.replaying-*` file in place for the next startup's recovery pass. */
async function safeProcessReplayingFile(o: JournalOpts, replayingPath: string, agentFile: string): Promise<{ replayed: number; kept: number }> {
  try { return await processReplayingFile(o, replayingPath, agentFile); }
  catch (e) {
    o.logger.warn("journal: file skipped this start", { file: agentFile, err: e });
    return { replayed: 0, kept: countLinesBestEffort(o, replayingPath) };
  } finally { o.hooks?.fileDone(); }
}

/** Non-blank lines (a torn tail counts), read in chunks: the file may be larger than a string or the heap can hold. */
function countLinesBestEffort(o: Pick<JournalOpts, "logger">, path: string): number {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let n = 0; let content = false;
    for (let r = readSync(fd, chunk, 0, chunk.length, null); r > 0; r = readSync(fd, chunk, 0, chunk.length, null)) {
      for (let i = 0; i < r; i++) {
        const b = chunk[i]!;
        if (b === NL) { if (content) n++; content = false; }
        else if (b !== 0x20 && b !== 0x09 && b !== 0x0d) content = true;
      }
    }
    return content ? n + 1 : n;
  } catch (e) { o.logger.warn("journal: could not count kept lines after skip", { path, err: e }); return 0; }
  finally { if (fd !== null) try { closeSync(fd); } catch { /* nothing to do */ } }
}

const READ_CHUNK = 64 * 1024;
interface RawLine {
  /** Byte offsets of the line in the file, without its `\n`. */
  start: number; end: number;
  /** False only for the last line of a file that does not end with `\n`. */
  terminated: boolean;
  /** Longer than the bound: `text` is empty, the line was not held. */
  oversize: boolean;
  /** Only spaces, tabs and CRs (an empty line included). */
  blank: boolean;
  text: string;
}

/** The lines of an open file, in order, read in chunks. A line is decoded as a whole, never per chunk, so a UTF-8
 *  character split across two reads comes through intact; one past `maxBytes` is skipped over without being kept. */
function* readLines(fd: number, maxBytes: number): Generator<RawLine> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  let pieces: Buffer[] = []; let len = 0; let over = false; let blank = true; let lineStart = 0; let base = 0;
  for (let r = readSync(fd, chunk, 0, chunk.length, null); r > 0; r = readSync(fd, chunk, 0, chunk.length, null)) {
    const view = chunk.subarray(0, r); // the rest of `chunk` is stale
    for (let from = 0; from < r;) {
      const nl = view.indexOf(NL, from);
      const stop = nl === -1 ? r : nl;
      if (blank && !isBlank(view, from, stop)) blank = false;
      if (!over && len + (stop - from) > maxBytes) { over = true; pieces = []; }
      if (nl === -1) {
        if (!over && stop > from) pieces.push(Buffer.from(view.subarray(from, stop))); // copy: `chunk` is reused
        len += stop - from;
        break;
      }
      const text = over ? "" : pieces.length ? Buffer.concat([...pieces, view.subarray(from, stop)]).toString("utf8") : view.toString("utf8", from, stop);
      yield { start: lineStart, end: base + stop, terminated: true, oversize: over, blank, text };
      pieces = []; len = 0; over = false; blank = true; lineStart = base + nl + 1; from = nl + 1;
    }
    base += r;
  }
  if (len > 0) yield { start: lineStart, end: base, terminated: false, oversize: over, blank, text: over ? "" : Buffer.concat(pieces).toString("utf8") };
}

function writeAll(fd: number, buf: Buffer): void {
  for (let n = 0; n < buf.length;) n += writeSync(fd, buf, n, buf.length - n);
}

/** Appends the kept lines to `agentPath`, each followed by its own `\n`, in their order: text in one write per run,
 *  ranges copied from `replayingPath` in 1 MiB pieces. */
function appendKept(agentPath: string, replayingPath: string, kept: KeptLine[]): void {
  const out = openSync(agentPath, "a", 0o600);
  let src: number | null = null;
  try {
    let texts: string[] = [];
    const flush = (): void => { if (texts.length) { writeAll(out, Buffer.from(`${texts.join("\n")}\n`)); texts = []; } };
    for (const k of kept) {
      if ("text" in k) { texts.push(k.text); continue; }
      flush();
      src ??= openSync(replayingPath, "r");
      const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, k.end - k.start));
      for (let pos = k.start; pos < k.end;) {
        const r = readSync(src, buf, 0, Math.min(buf.length, k.end - pos), pos);
        if (r === 0) throw new Error("journal: the replaying file ended before a kept line did");
        writeAll(out, buf.subarray(0, r)); pos += r;
      }
      writeAll(out, Buffer.from("\n"));
    }
    flush();
  } finally {
    closeSync(out);
    if (src !== null) try { closeSync(src); } catch { /* nothing to do */ }
  }
}

async function processReplayingFile(o: JournalOpts, replayingPath: string, agentFile: string): Promise<{ replayed: number; kept: number }> {
  let replayed = 0;
  let nonEmpty = 0; // physical lines with any byte in them (blank ones too): what an abandoned file reports
  const kept: KeptLine[] = []; let keptCount = 0;
  let abortedAt: number | null = null;
  const keepRange = (start: number, end: number): void => {
    const last = kept[kept.length - 1];
    if (last && "end" in last && last.end + 1 === start) last.end = end; // adjacent lines are one range, newline included
    else kept.push({ start, end });
    keptCount += 1;
  };
  const keepText = (text: string): void => { kept.push({ text }); keptCount += 1; };
  const maxLineBytes = o.maxLineBytes ?? JOURNAL_LINE_MAX_BYTES;

  const fd = openSync(replayingPath, "r");
  try {
    for (const raw of readLines(fd, maxLineBytes)) {
      if (raw.end > raw.start) nonEmpty += 1;
      if (raw.blank) continue; // blank (a bare CR from CRLF tooling too): nothing to replay, nothing to keep
      const isPhysicalTail = !raw.terminated; // R20.3: a complete tail is still replayed; only unparseable/invalid stays torn
      // B2: a stop aborts between lines; this and every later line go back unchanged, without a capture call.
      if (o.signal?.aborted) { abortedAt ??= keptCount; keepRange(raw.start, raw.end); continue; }
      if (raw.oversize) {
        o.logger.warn("journal: oversize line kept", { file: agentFile, bytes: raw.end - raw.start, limit: maxLineBytes, tail: isPhysicalTail });
        keepRange(raw.start, raw.end);
        continue;
      }
      const text = raw.text;
      const clean = text.endsWith("\r") ? text.slice(0, -1) : text; // R20.4: CRLF tolerance

      let line: JournalLine;
      try {
        const parsed = JSON.parse(clean);
        const v = validateJournalLine(parsed);
        if (!v.ok) throw new Error(v.errors.join("; "));
        line = parsed;
      } catch (e) {
        o.logger.warn(isPhysicalTail ? "journal: torn tail kept" : "journal: unparseable line kept", { file: agentFile, err: e });
        keepText(text);
        continue;
      }

      const ws = o.agents.workspaceOf(line.agentId);
      if (!ws) { o.logger.warn("journal: agent not registered, line kept", { file: agentFile, agentId: line.agentId }); keepText(text); continue; }

      const { principal } = callerToPrincipal(line.caller, line.agentId, ws);
      let handled = false;
      try {
        // Diagnostic, paired with "journal: replayed" below: which line a replay is capturing, and by which core pid.
        o.logger.info("journal: replay start", { id: line.id, pid: process.pid });
        const handle = o.engine.capture({ agentId: line.agentId, principal, agent: AGENT_CONTEXT_CLI, messages: line.messages, incognito: false, signal: AbortSignal.timeout(60_000), ...(line.sessionKey ? { sessionKey: line.sessionKey } : {}), runId: `journal:${line.id}` });
        const r = await handle.done;
        // E4 (1.8.0): `duplicate-turn` means this line's runId was already captured (a core killed mid-replay
        // replays it again), so the turn is stored and the line is done.
        handled = (r.reason == null && r.stored + r.skipped > 0) || r.reason === "duplicate-turn";
        if (handled) { replayed += 1; o.logger.info("journal: replayed", { file: agentFile, id: line.id, pid: process.pid, stored: r.stored, skipped: r.skipped }); }
        else { o.logger.warn("journal: capture not handled, line kept", { file: agentFile, id: line.id, reason: r.reason, stored: r.stored, skipped: r.skipped }); keepText(text); }
      } catch (e) {
        // R20.1: a rejected `done` keeps the line and replay continues with the next line/file.
        o.logger.warn("journal: capture threw, line kept", { file: agentFile, id: line.id, err: e });
        keepText(text);
      }
      // Outside the capture's try: a failing observer never turns a stored line into a kept one.
      if (handled) { try { o.hooks?.lineReplayed(); } catch { /* progress only */ } }
    }
  } finally { try { closeSync(fd); } catch { /* nothing to do */ } }

  // H3B-R2: a stop that gave up waiting for this file's capture owns nothing any more; the file stays as it is and
  // the next start's recovery replays it (the line in flight then answers duplicate-turn).
  if (o.hooks?.abandoned()) return { replayed: 0, kept: nonEmpty };
  if (abortedAt !== null) { o.hooks?.cut(); o.logger.info("journal: replay aborted, rest of the file kept", { file: agentFile, kept: keptCount - abortedAt }); }
  const agentPath = join(o.dir, agentFile);
  // Round 2 fix: every kept line — including a torn/unparseable tail — gets its own trailing "\n", so a
  // subsequent appendJournalLine from the CLI can never glue onto it and corrupt that new line.
  // R20.2: append, never overwrite — `agentPath` may have been recreated by a concurrent CLI append while we were replaying.
  if (kept.length) appendKept(agentPath, replayingPath, kept);
  rmSync(replayingPath, { force: true });
  return { replayed, kept: keptCount };
}
