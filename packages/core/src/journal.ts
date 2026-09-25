import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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

interface KeptLine { text: string; isPhysicalTail: boolean }
type ReplayEngine = Pick<Engine, "capture">;
type JournalOpts = { dir: string; agents: AgentRegistry; engine: ReplayEngine; logger: HarnessLogger; clock: () => number };

/** Replays state/journal/<agentId>.jsonl at core start.
 *
 *  R20: a line leaves the journal only when `capture(...).done` resolves with NO `reason` and
 *  `stored + skipped > 0` (the engine's ok path — a dedup skip with no reason still counts as handled).
 *  Any reason, zero counts, or a rejected `done` keeps the line (logged with why), and replay continues
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
    const replayingPath = join(o.dir, entry);
    const agentFile = entry.replace(/\.replaying-\d+$/, "");
    const r = await safeProcessReplayingFile(o, replayingPath, agentFile);
    replayed += r.replayed; kept += r.kept;
  }

  for (const file of readdirSync(o.dir).filter((f) => f.endsWith(".jsonl") && !REPLAYING_SUFFIX.test(f))) {
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

/** Never throws: a failure processing an already-renamed file is logged and its lines counted as kept
 *  on a best-effort basis, leaving the `.replaying-*` file in place for the next startup's recovery pass. */
async function safeProcessReplayingFile(o: JournalOpts, replayingPath: string, agentFile: string): Promise<{ replayed: number; kept: number }> {
  try { return await processReplayingFile(o, replayingPath, agentFile); }
  catch (e) {
    o.logger.warn("journal: file skipped this start", { file: agentFile, err: e });
    return { replayed: 0, kept: countLinesBestEffort(o, replayingPath) };
  }
}

function countLinesBestEffort(o: JournalOpts, path: string): number {
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

  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i]!;
    if (!text) continue;
    const isPhysicalTail = i === rawLines.length - 1 && !endedWithNewline; // R20.3: a complete tail is still replayed; only unparseable/invalid stays torn
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
    try {
      const handle = o.engine.capture({ agentId: line.agentId, principal, agent: AGENT_CONTEXT_CLI, messages: line.messages, incognito: false, signal: AbortSignal.timeout(60_000), ...(line.sessionKey ? { sessionKey: line.sessionKey } : {}), runId: `journal:${line.id}` });
      const r = await handle.done;
      const handled = r.reason == null && r.stored + r.skipped > 0;
      if (handled) { replayed += 1; o.logger.info("journal: replayed", { file: agentFile, id: line.id, stored: r.stored, skipped: r.skipped }); }
      else { o.logger.warn("journal: capture not handled, line kept", { file: agentFile, id: line.id, reason: r.reason, stored: r.stored, skipped: r.skipped }); kept.push({ text, isPhysicalTail }); }
    } catch (e) {
      // R20.1: a rejected `done` keeps the line and replay continues with the next line/file.
      o.logger.warn("journal: capture threw, line kept", { file: agentFile, id: line.id, err: e });
      kept.push({ text, isPhysicalTail });
    }
  }

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
