import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import type { JournalLine } from "@plur1bus/rpc-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { appendJournalLine, countJournalLines, JOURNAL_LINE_MAX_BYTES, replayJournal } from "../src/journal.ts";
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

  it("a replaying file is streamed line by line: a 128 MiB journal does not sit in memory (was KNOWN GAP: readFileSync)", async () => {
    const { l, agents, logger } = setup();
    const f = join(l.journal, "bernd.jsonl");
    const fd = openSync(f, "w", 0o600);
    const block = Buffer.from(`${" ".repeat(255)}\n`.repeat(16384)); // 4 MiB of blank lines: skipped without parsing, so only the reader costs memory
    try {
      writeSync(fd, `${JSON.stringify(line(1, "first"))}\n`);
      for (let i = 0; i < 32; i++) writeSync(fd, block);
      writeSync(fd, `${JSON.stringify(line(2, "last"))}\n`);
    } finally { closeSync(fd); }
    const base = process.memoryUsage.rss();
    let peak = 0; const captured: string[] = [];
    const engine = { capture: (t: any) => { peak = Math.max(peak, process.memoryUsage.rss() - base); captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(captured, ["first", "last"]);
    assert.deepEqual(r, { replayed: 2, kept: 0 });
    assert.equal(readdirSync(l.journal).length, 0, "the finished file is gone");
    assert.ok(peak < 64 * 1024 * 1024, `memory grew by ${Math.round(peak / 1048576)} MiB while a 128 MiB file replayed`);
  });

  it("UTF-8 characters and CRLF endings that straddle read-chunk boundaries come through intact", async () => {
    const { l, agents, logger, engine, captured } = setup();
    // 4 different paddings move the 2-, 3- and 4-byte characters over every alignment of the reader's chunk edge.
    const contents = [0, 1, 2, 3].map((k) => `${"x".repeat(k)}${"ä€😀".repeat(30_000)}`);
    const rows = contents.map((c, i) => JSON.stringify(line(i + 1, c)));
    // CRLF on the first row, a bare LF on the others, and the last row without a final newline (a complete tail is still replayed).
    writeFileSync(join(l.journal, "bernd.jsonl"), `${rows[0]}\r\n${rows[1]}\n${rows[2]}\n${rows[3]}`);
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(captured, contents);
    assert.deepEqual(r, { replayed: 4, kept: 0 });
  });

  it("a line over the bound is counted as defective, logged and skipped; the lines around it replay in order and it is kept byte for byte", async () => {
    const { l, agents, logger, engine, captured } = setup();
    const warnings: string[] = [];
    const origWarn = logger.warn; logger.warn = (m, f) => { warnings.push(m); origWarn(m, f); };
    const big = `{"v":1,"id":"x","pad":"${"ä€😀".repeat(500)}"}`; // 5 KB of multi-byte text, far over a 1000-byte bound
    writeFileSync(join(l.journal, "bernd.jsonl"), [JSON.stringify(line(1, "a")), big, "not json at all", JSON.stringify(line(2, "b"))].map((t) => `${t}\n`).join(""));
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1, maxLineBytes: 1000 });
    assert.deepEqual(captured, ["a", "b"]);
    assert.deepEqual(r, { replayed: 2, kept: 2 }); // the oversize line and the unparseable one
    assert.ok(warnings.includes("journal: oversize line kept"), warnings.join(" | "));
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), `${big}\nnot json at all\n`, "kept lines keep their order and bytes");
    assert.equal(readdirSync(l.journal).filter((f) => f.includes("replaying")).length, 0);
    assert.equal(countJournalLines({ dir: l.journal, logger }), 2);
  });

  it("the bound is inclusive: a line of exactly maxLineBytes replays, one byte more is kept", async () => {
    const { l, agents, logger, engine, captured } = setup();
    const row = JSON.stringify(line(1, "edge"));
    const n = Buffer.byteLength(row);
    writeFileSync(join(l.journal, "bernd.jsonl"), `${row}\n`);
    assert.deepEqual(await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1, maxLineBytes: n }), { replayed: 1, kept: 0 });
    assert.deepEqual(captured, ["edge"]);
    writeFileSync(join(l.journal, "bernd.jsonl"), `${row}\n`);
    assert.deepEqual(await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1, maxLineBytes: n - 1 }), { replayed: 0, kept: 1 });
    assert.deepEqual(captured, ["edge"], "the over-long line is never captured");
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), `${row}\n`);
  });

  it("an over-long torn tail (no final newline) is kept with its own newline; the default bound is JOURNAL_LINE_MAX_BYTES", async () => {
    const { l, agents, logger, engine, captured } = setup();
    const tail = "y".repeat(JOURNAL_LINE_MAX_BYTES + 1); // one byte over the default bound, unterminated
    writeFileSync(join(l.journal, "bernd.jsonl"), `${JSON.stringify(line(1, "ok"))}\n${tail}`);
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(captured, ["ok"]);
    assert.deepEqual(r, { replayed: 1, kept: 1 });
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), `${tail}\n`);
    appendJournalLine(l.journal, line(2, "next")); // nothing glues onto the kept fragment
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8").endsWith(`${tail}\n${JSON.stringify(line(2, "next"))}\n`), true);
    rmSync(join(l.journal, "bernd.jsonl"));
  });

  it("an abort keeps the rest of the file unchanged and in order, over-long lines included", async () => {
    const { l, agents, logger } = setup();
    const ac = new AbortController(); const captured: string[] = [];
    const engine = { capture: (t: any) => { captured.push(t.messages[0].content); ac.abort(); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
    const big = "z".repeat(3000);
    const rest = [JSON.stringify(line(2, "b")), big, "", JSON.stringify(line(3, "c"))];
    writeFileSync(join(l.journal, "bernd.jsonl"), [JSON.stringify(line(1, "a")), ...rest].map((t) => `${t}\n`).join(""));
    let cuts = 0;
    const hooks = { lineReplayed() {}, fileDone() {}, cut() { cuts++; }, abandoned: () => false };
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1, signal: ac.signal, hooks, maxLineBytes: 1000 });
    assert.deepEqual(captured, ["a"]);
    assert.deepEqual(r, { replayed: 1, kept: 3 }); // the blank line leaves the journal
    assert.ok(cuts >= 1);
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), [rest[0], big, rest[3]].map((t) => `${t}\n`).join(""));
  });
});
