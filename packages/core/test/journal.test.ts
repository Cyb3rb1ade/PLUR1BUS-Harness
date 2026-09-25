import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import type { JournalLine } from "@plur1bus/rpc-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { appendJournalLine, replayJournal } from "../src/journal.ts";
import { createLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";

const caller = { channel: "cli" as const, accountId: "h", userId: "u" };
// messages must type as JournalLine's non-empty tuple, not a plain array, for strict tsc.
const line = (id: string, content: string): JournalLine => ({ v: 1, id, at: 1, agentId: "bernd", sessionKey: "s1", caller, messages: [{ role: "user", content }] });

describe("journal", () => {
  it("replays complete lines and keeps a torn tail", async () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-journal-"))); mkdirSync(l.journal, { recursive: true });
    const cfg = defaults(); cfg.agents.bernd = {}; const agents = createAgentRegistry(cfg, l); agents.scaffold("bernd");
    appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "one"));
    appendJournalLine(l.journal, line("22222222-2222-4222-8222-222222222222", "two"));
    writeFileSync(join(l.journal, "bernd.jsonl"), '{"v":1,"id":"33333333-3333-4333-8333-3', { flag: "a" });
    const captured: string[] = [];
    const engine = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
    const warnings: string[] = [];
    const logger = createLogger({ file: l.logFile("core"), level: "debug", role: "core" }); const origWarn = logger.warn; logger.warn = (m, f) => { warnings.push(m); origWarn(m, f); };
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(r, { replayed: 2, kept: 1 });
    assert.deepEqual(captured, ["one", "two"]);
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), '{"v":1,"id":"33333333-3333-4333-8333-3');
    assert.ok(warnings.some((w) => /torn|unparseable/.test(w)));
  });
  it("keeps a line whose capture failed, and a line for an unregistered agent, with a reason in the log", async () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-journal-"))); mkdirSync(l.journal, { recursive: true });
    const cfg = defaults(); cfg.agents.bernd = {}; const agents = createAgentRegistry(cfg, l); agents.scaffold("bernd");
    appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "fails"));
    appendJournalLine(l.journal, { ...line("22222222-2222-4222-8222-222222222222", "ghost"), agentId: "ghost" });
    const engine = { capture: () => ({ id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 0, skipped: 1, reason: "engine-closed" }), abort() {} }) } as any;
    const r = await replayJournal({ dir: l.journal, agents, engine, logger: createLogger({ file: l.logFile("core"), level: "debug", role: "core" }), clock: () => 1 });
    assert.deepEqual(r, { replayed: 0, kept: 2 });
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(l.journal, "ghost.jsonl"), "utf8").trim().split("\n").length, 1);
  });
});
