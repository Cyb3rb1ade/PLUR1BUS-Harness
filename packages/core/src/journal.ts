import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Replays state/journal/<agentId>.jsonl: a line is removed only after the engine reports it stored or deliberately skipped
 *  (skipped with a reason other than a failure is still "handled"); failures, unregistered agents and unparseable lines stay. */
export async function replayJournal(o: { dir: string; agents: AgentRegistry; engine: Pick<Engine, "capture">; logger: HarnessLogger; clock: () => number }): Promise<{ replayed: number; kept: number }> {
  let replayed = 0; let kept = 0;
  if (!existsSync(o.dir)) return { replayed, kept };
  for (const file of readdirSync(o.dir).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(o.dir, file);
    const raw = readFileSync(path, "utf8");
    const keep: string[] = [];
    const lines = raw.split("\n");
    const tail = raw.endsWith("\n") ? null : lines.pop(); // a torn last line has no newline
    for (const text of lines) {
      if (!text) continue;
      let line: JournalLine;
      try { const parsed = JSON.parse(text); const v = validateJournalLine(parsed); if (!v.ok) throw new Error(v.errors.join("; ")); line = parsed; }
      catch (e) { o.logger.warn("journal: unparseable line kept", { file, err: e }); keep.push(text); continue; }
      const ws = o.agents.workspaceOf(line.agentId);
      if (!ws) { o.logger.warn("journal: agent not registered, line kept", { file, agentId: line.agentId }); keep.push(text); continue; }
      const { principal } = callerToPrincipal(line.caller, line.agentId, ws);
      const handle = o.engine.capture({ agentId: line.agentId, principal, agent: AGENT_CONTEXT_CLI, messages: line.messages, incognito: false, signal: AbortSignal.timeout(60_000), ...(line.sessionKey ? { sessionKey: line.sessionKey } : {}), runId: `journal:${line.id}` });
      const r = await handle.done;
      const failed = r.stored === 0 && r.skipped > 0 && /engine-closed|aborted|timeout|error/i.test(r.reason ?? "");
      if (failed) { o.logger.warn("journal: capture failed, line kept", { file, id: line.id, reason: r.reason }); keep.push(text); }
      else { replayed += 1; o.logger.info("journal: replayed", { file, id: line.id, stored: r.stored, skipped: r.skipped }); }
    }
    if (tail !== null && tail !== undefined && tail.length) { o.logger.warn("journal: torn tail kept", { file, bytes: tail.length }); keep.push(tail); }
    kept += keep.length;
    const out = keep.length ? `${keep.join("\n")}${tail && keep.at(-1) === tail ? "" : "\n"}` : "";
    const tmp = `${path}.tmp`; writeFileSync(tmp, out, { mode: 0o600 }); renameSync(tmp, path);
  }
  return { replayed, kept };
}
