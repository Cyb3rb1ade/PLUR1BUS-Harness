import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import type { JournalLine } from "@plur1bus/rpc-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { appendJournalLine, countJournalLines, replayJournal } from "../src/journal.ts";
import { createLogger, type HarnessLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const caller = { channel: "cli" as const, accountId: "h", userId: "u" };
const id = (n: number): string => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const line = (n: number, content: string): JournalLine => ({ v: 1, id: id(n), at: 1, agentId: "bernd", sessionKey: "s1", caller, messages: [{ role: "user", content }] });
const loggers: HarnessLogger[] = [];
after(() => Promise.all(loggers.splice(0).map((lg) => lg.close())));

function setup() {
  const l = layout(tempDir("p1b-journal-hard-")); mkdirSync(l.journal, { recursive: true });
  const cfg = defaults(); cfg.agents.bernd = {}; const agents = createAgentRegistry(cfg, l); agents.scaffold("bernd");
  const logger = createLogger({ file: l.logFile("core"), level: "debug", role: "core" }); loggers.push(logger);
  const captured: string[] = [];
  const engine = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
  return { l, agents, logger, engine, captured };
}

describe("journal hardening (c02)", () => {
  it("appendJournalLine starts a line of its own after a torn tail instead of gluing onto it", async () => {
    const { l, agents, logger, engine, captured } = setup();
    writeFileSync(join(l.journal, "bernd.jsonl"), '{"v":1,"id":"33333333-3333-4333-8333-3'); // a crashed writer's fragment, no "\n"
    appendJournalLine(l.journal, line(1, "after-crash"));
    const lines = readFileSync(join(l.journal, "bernd.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1] as string).messages[0].content, "after-crash");
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(captured, ["after-crash"]);
    assert.deepEqual(r, { replayed: 1, kept: 1 });
  });

  it("appendJournalLine refuses an agentId that is not a plain agent id (no path traversal out of the journal)", () => {
    const l = layout(tempDir("p1b-journal-hard-"));
    for (const bad of ["../escape", "a/b", "..", "", "A"]) {
      assert.throws(() => appendJournalLine(l.journal, { ...line(1, "x"), agentId: bad }), /agentId|journal line/i, bad);
    }
    assert.equal(existsSync(join(l.journal, "..", "escape.jsonl")), false);
    assert.equal(existsSync(l.journal) ? readdirSync(l.journal).length : 0, 0);
  });

  it("a replay never renames a journal file over a leftover .replaying file of the same pid", async () => {
    const { l, agents, logger, engine } = setup();
    const left = join(l.journal, `bernd.jsonl.replaying-${process.pid}`);
    writeFileSync(left, `${JSON.stringify(line(1, "leftover"))}\n`);
    appendJournalLine(l.journal, line(2, "fresh"));
    // A stop that gave up waiting abandons the file in progress: it stays exactly as it is.
    const hooks = { lineReplayed() {}, fileDone() {}, cut() {}, abandoned: () => true };
    await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1, hooks });
    const all = readdirSync(l.journal).map((f) => readFileSync(join(l.journal, f), "utf8")).join("");
    assert.ok(all.includes("leftover"), "the abandoned file's line must survive");
    assert.ok(all.includes("fresh"), "the fresh line must survive");
  });

  it("blank lines (including a bare CR from CRLF tooling) leave the journal instead of being kept forever", async () => {
    const { l, agents, logger, engine, captured } = setup();
    writeFileSync(join(l.journal, "bernd.jsonl"), `\r\n  \r\n${JSON.stringify(line(1, "real"))}\r\n`);
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(captured, ["real"]);
    assert.deepEqual(r, { replayed: 1, kept: 0 });
    assert.equal(countJournalLines({ dir: l.journal, logger }), 0);
  });

  it("countJournalLines counts a file too large to hold as one string (no silent zero)", () => {
    const { l, logger } = setup();
    const f = join(l.journal, "bernd.jsonl");
    writeFileSync(f, ""); truncateSync(f, 540 * 1024 * 1024); // sparse, one huge unterminated "line" of NULs
    assert.equal(countJournalLines({ dir: l.journal, logger }), 1);
  });

  it("KNOWN GAP: a replaying file is read whole into memory (needs a streaming line reader and a per-line bound)", { todo: true }, () => {
    assert.fail("processReplayingFile uses readFileSync; a multi-hundred-MiB journal file spikes the heap before any line is checked");
  });
});
