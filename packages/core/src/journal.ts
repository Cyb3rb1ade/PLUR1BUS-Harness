import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { validateJournalLine, type JournalLine } from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "./agents.ts";
import type { HarnessLogger } from "./logger.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "./principal.ts";

export function appendJournalLine(dir: string, line: JournalLine): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, `${line.agentId}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

const REPLAYING_SUFFIX = /\.jsonl\.replaying-\d+$/;

/** `journalBacklog` stops counting at either bound and reports what it counted up to there (the engine waits at most
 *  50 ms for it): at most this many lines … */
export const JOURNAL_BACKLOG_MAX_ENTRIES = 100_000;
/** … and at most this many bytes read across all journal files. */
export const JOURNAL_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;
/** Both writers (the CLI's serde struct and `appendJournalLine`) emit `v`, `id`, `at` first; anything else is parsed. */
const AT_PREFIX = /^\{"v":1,"id":"[^"\\]*","at":(\d+)[,}]/;
const AT_PREFIX_BYTES = 128;
const NL = 0x0a;

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

interface KeptLine { text: string; isPhysicalTail: boolean }
export type ReplayEngine = Pick<Engine, "capture">;
/** What the background replay (replay.ts) observes. `lineReplayed`: a line was handled (it leaves the journal when its
 *  file is finished); `fileDone`: a `.replaying-*` file was finished (removed, or left after a failure); `cut`: the
 *  abort left lines unreplayed; `abandoned`: a stop gave up waiting (H3B-R2) — the file in progress is then left
 *  exactly as it is (no append-back, no delete) for the next start's recovery. */
export interface ReplayHooks { lineReplayed(): void; fileDone(): void; cut(): void; abandoned(): boolean }
/** `signal` (B2): once aborted, the replay stops between lines — the capture in flight runs to its end under its own
 *  timeout, the rest of the current file is kept without a capture call, no further file is renamed and no further
 *  pass runs. */
export type JournalOpts = { dir: string; agents: AgentRegistry; engine: ReplayEngine; logger: HarnessLogger; clock: () => number; signal?: AbortSignal; hooks?: ReplayHooks };

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
 *  counted as kept on a best-effort basis, and replay continues with the next file. */
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

function countLinesBestEffort(o: Pick<JournalOpts, "logger">, path: string): number {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean).length; }
  catch (e) { o.logger.warn("journal: could not count kept lines after skip", { path, err: e }); return 0; }
}

async function processReplayingFile(o: JournalOpts, replayingPath: string, agentFile: string): Promise<{ replayed: number; kept: number }> {
  let replayed = 0;
  const raw = readFileSync(replayingPath, "utf8");
  const endedWithNewline = raw.endsWith("\n");
  const rawLines = raw.split("\n");
  if (endedWithNewline) rawLines.pop(); // trailing "" after the final \n
  const kept: KeptLine[] = [];
  let abortedAt: number | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i]!;
    if (!text) continue;
    const isPhysicalTail = i === rawLines.length - 1 && !endedWithNewline; // R20.3: a complete tail is still replayed; only unparseable/invalid stays torn
    // B2: a stop aborts between lines; this and every later line go back unchanged, without a capture call.
    if (o.signal?.aborted) { abortedAt ??= kept.length; kept.push({ text, isPhysicalTail }); continue; }
    const clean = text.endsWith("\r") ? text.slice(0, -1) : text; // R20.4: CRLF tolerance

    let line: JournalLine;
    try {
      const parsed = JSON.parse(clean);
      const v = validateJournalLine(parsed);
      if (!v.ok) throw new Error(v.errors.join("; "));
      line = parsed;
    } catch (e) {
      o.logger.warn(isPhysicalTail ? "journal: torn tail kept" : "journal: unparseable line kept", { file: agentFile, err: e });
      kept.push({ text, isPhysicalTail });
      continue;
    }

    const ws = o.agents.workspaceOf(line.agentId);
    if (!ws) { o.logger.warn("journal: agent not registered, line kept", { file: agentFile, agentId: line.agentId }); kept.push({ text, isPhysicalTail }); continue; }

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
      else { o.logger.warn("journal: capture not handled, line kept", { file: agentFile, id: line.id, reason: r.reason, stored: r.stored, skipped: r.skipped }); kept.push({ text, isPhysicalTail }); }
    } catch (e) {
      // R20.1: a rejected `done` keeps the line and replay continues with the next line/file.
      o.logger.warn("journal: capture threw, line kept", { file: agentFile, id: line.id, err: e });
      kept.push({ text, isPhysicalTail });
    }
    // Outside the capture's try: a failing observer never turns a stored line into a kept one.
    if (handled) { try { o.hooks?.lineReplayed(); } catch { /* progress only */ } }
  }

  // H3B-R2: a stop that gave up waiting for this file's capture owns nothing any more; the file stays as it is and
  // the next start's recovery replays it (the line in flight then answers duplicate-turn).
  if (o.hooks?.abandoned()) return { replayed: 0, kept: rawLines.filter(Boolean).length };
  if (abortedAt !== null) { o.hooks?.cut(); o.logger.info("journal: replay aborted, rest of the file kept", { file: agentFile, kept: kept.length - abortedAt }); }
  const agentPath = join(o.dir, agentFile);
  if (kept.length) {
    // Round 2 fix: every kept line — including a torn/unparseable tail — gets its own trailing "\n", so a
    // subsequent appendJournalLine from the CLI can never glue onto it and corrupt that new line.
    const out = `${kept.map((k) => k.text).join("\n")}\n`;
    // R20.2: append, never overwrite — `agentPath` may have been recreated by a concurrent CLI append while we were replaying.
    appendFileSync(agentPath, out, { mode: 0o600 });
  }
  rmSync(replayingPath, { force: true });
  return { replayed, kept: kept.length };
}
