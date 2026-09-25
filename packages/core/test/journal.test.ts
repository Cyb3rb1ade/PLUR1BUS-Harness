import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import type { JournalLine } from "@plur1bus/rpc-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { appendJournalLine, drainJournal, replayJournal } from "../src/journal.ts";
import { createLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";

const caller = { channel: "cli" as const, accountId: "h", userId: "u" };
// messages must type as JournalLine's non-empty tuple, not a plain array, for strict tsc.
const line = (id: string, content: string): JournalLine => ({ v: 1, id, at: 1, agentId: "bernd", sessionKey: "s1", caller, messages: [{ role: "user", content }] });

function setup() {
  const l = layout(mkdtempSync(join(tmpdir(), "p1b-journal-"))); mkdirSync(l.journal, { recursive: true });
  const cfg = defaults(); cfg.agents.bernd = {}; const agents = createAgentRegistry(cfg, l); agents.scaffold("bernd");
  const logger = createLogger({ file: l.logFile("core"), level: "debug", role: "core" });
  return { l, agents, logger };
}

describe("journal", () => {
  it("replays complete lines and keeps a torn tail", async () => {
    const { l, agents, logger } = setup();
    appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "one"));
    appendJournalLine(l.journal, line("22222222-2222-4222-8222-222222222222", "two"));
    writeFileSync(join(l.journal, "bernd.jsonl"), '{"v":1,"id":"33333333-3333-4333-8333-3', { flag: "a" });
    const captured: string[] = [];
    const engine = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
    const warnings: string[] = [];
    const origWarn = logger.warn; logger.warn = (m, f) => { warnings.push(m); origWarn(m, f); };
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(r, { replayed: 2, kept: 1 });
    assert.deepEqual(captured, ["one", "two"]);
    // Round 2 fix: a kept torn tail always gets its own trailing "\n" back, so a later CLI append can never glue onto it.
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), '{"v":1,"id":"33333333-3333-4333-8333-3\n');
    assert.ok(warnings.some((w) => /torn|unparseable/.test(w)));
  });

  it("keeps a line whose capture failed, and a line for an unregistered agent, with a reason in the log", async () => {
    const { l, agents, logger } = setup();
    appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "fails"));
    appendJournalLine(l.journal, { ...line("22222222-2222-4222-8222-222222222222", "ghost"), agentId: "ghost" });
    const engine = { capture: () => ({ id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 0, skipped: 1, reason: "engine-closed" }), abort() {} }) } as any;
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(r, { replayed: 0, kept: 2 });
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(l.journal, "ghost.jsonl"), "utf8").trim().split("\n").length, 1);
  });

  // R20.1: "handled" is decided by { reason, stored, skipped } alone, never a regex on the reason text.
  describe("R20.1: handled rule", () => {
    it("keeps a line whose capture resolves {stored:0, skipped:0}", async () => {
      const { l, agents, logger } = setup();
      appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "zero"));
      const engine = { capture: () => ({ id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 0, skipped: 0 }), abort() {} }) } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(r, { replayed: 0, kept: 1 });
      assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8").trim().split("\n").length, 1);
    });

    it("keeps a line whose capture resolves {stored:0, skipped:1, reason:\"not_captured\"}", async () => {
      const { l, agents, logger } = setup();
      appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "notcaptured"));
      const engine = { capture: () => ({ id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 0, skipped: 1, reason: "not_captured" }), abort() {} }) } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(r, { replayed: 0, kept: 1 });
      assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8").trim().split("\n").length, 1);
    });

    it("removes a line whose capture resolves {stored:0, skipped:1} with no reason (dedup)", async () => {
      const { l, agents, logger } = setup();
      appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "dedup"));
      const engine = { capture: () => ({ id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 0, skipped: 1 }), abort() {} }) } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(r, { replayed: 1, kept: 0 });
      assert.equal(existsSync(join(l.journal, "bernd.jsonl")) && readFileSync(join(l.journal, "bernd.jsonl"), "utf8").length > 0, false);
    });

    it("keeps a line whose capture's done rejects, and replay continues with the next line and the next file", async () => {
      const { l, agents, logger } = setup();
      appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "boom"));
      appendJournalLine(l.journal, line("22222222-2222-4222-8222-222222222222", "after-boom"));
      appendJournalLine(l.journal, { ...line("33333333-3333-4333-8333-333333333333", "other-file"), agentId: "otherbernd" });
      const cfg2 = defaults(); cfg2.agents.bernd = {}; cfg2.agents.otherbernd = {};
      const agents2 = createAgentRegistry(cfg2, l); agents2.scaffold("bernd"); agents2.scaffold("otherbernd");
      const captured: string[] = [];
      let calls = 0;
      const engine = {
        capture: (t: any) => {
          calls += 1;
          captured.push(t.messages[0].content);
          if (t.messages[0].content === "boom") return { id: "x", acceptedAt: 1, done: Promise.reject(new Error("engine down")), abort() {} };
          return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} };
        },
      } as any;
      const r = await replayJournal({ dir: l.journal, agents: agents2, engine, logger, clock: () => 1 });
      assert.equal(calls, 3, "capture was attempted for all three lines despite the rejection");
      assert.deepEqual(captured.sort(), ["after-boom", "boom", "other-file"]);
      assert.deepEqual(r, { replayed: 2, kept: 1 });
      assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8").trim().split("\n").length, 1);
      assert.equal(existsSync(join(l.journal, "otherbernd.jsonl")) && readFileSync(join(l.journal, "otherbernd.jsonl"), "utf8").length > 0, false);
    });
  });

  // R20.2: replay never loses a line the CLI appends while it is running.
  describe("R20.2: concurrent append safety", () => {
    it("keeps a line appended to <agent>.jsonl by the engine mid-replay", async () => {
      const { l, agents, logger } = setup();
      appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "one"));
      appendJournalLine(l.journal, line("22222222-2222-4222-8222-222222222222", "two"));
      const appended = line("33333333-3333-4333-8333-333333333333", "concurrent");
      let firstCall = true;
      const engine = {
        capture: (t: any) => {
          if (firstCall) { firstCall = false; appendJournalLine(l.journal, appended); } // simulates the CLI writing while <agent>.jsonl is renamed away
          return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} };
        },
      } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(r, { replayed: 2, kept: 0 });
      assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), `${JSON.stringify(appended)}\n`);
    });

    it("recovers a leftover *.jsonl.replaying-* file from a crashed prior replay before the regular scan", async () => {
      const { l, agents, logger } = setup();
      const leftover = line("11111111-1111-4111-8111-111111111111", "leftover");
      writeFileSync(join(l.journal, "bernd.jsonl.replaying-99999"), `${JSON.stringify(leftover)}\n`, { mode: 0o600 });
      const captured: string[] = [];
      const engine = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(captured, ["leftover"]);
      assert.equal(r.replayed, 1);
      assert.equal(readdirSync(l.journal).some((f) => f.includes(".replaying-")), false, "leftover replaying file was cleaned up");
    });
  });

  // R20.3 + R20.4: a complete, valid last line with no trailing newline is replayed; CRLF is tolerated.
  describe("R20.3 and R20.4: tail and CRLF handling", () => {
    it("replays a complete valid last line that has no trailing newline", async () => {
      const { l, agents, logger } = setup();
      const only = line("11111111-1111-4111-8111-111111111111", "no-newline-tail");
      writeFileSync(join(l.journal, "bernd.jsonl"), JSON.stringify(only), { mode: 0o600 }); // no trailing "\n"
      const captured: string[] = [];
      const engine = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(captured, ["no-newline-tail"]);
      assert.deepEqual(r, { replayed: 1, kept: 0 });
      assert.equal(existsSync(join(l.journal, "bernd.jsonl")) && readFileSync(join(l.journal, "bernd.jsonl"), "utf8").length > 0, false);
    });

    it("keeps an unparseable last line with no trailing newline as a torn tail (not replayed)", async () => {
      const { l, agents, logger } = setup();
      writeFileSync(join(l.journal, "bernd.jsonl"), '{"v":1,"id":"not-json', { mode: 0o600 });
      const engine = { capture: () => { throw new Error("must not be called"); } } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(r, { replayed: 0, kept: 1 });
      // Round 2 fix: the torn fragment comes back with a trailing "\n" — a complete, unparseable line, not a
      // dangling one a future append could glue onto.
      assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), '{"v":1,"id":"not-json\n');
    });

    it("a torn tail written back does not swallow a later CLI append (round 2)", async () => {
      const { l, agents, logger } = setup();
      writeFileSync(join(l.journal, "bernd.jsonl"), '{"v":1,"id":"not-json', { mode: 0o600 }); // no trailing newline: torn
      const noCapture = { capture: () => { throw new Error("must not be called"); } } as any;
      const first = await replayJournal({ dir: l.journal, agents, engine: noCapture, logger, clock: () => 1 });
      assert.deepEqual(first, { replayed: 0, kept: 1 });
      assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), '{"v":1,"id":"not-json\n');

      const fresh = line("22222222-2222-4222-8222-222222222222", "after-torn-tail");
      appendJournalLine(l.journal, fresh); // the CLI writing a new line after the kept fragment
      assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), `{"v":1,"id":"not-json\n${JSON.stringify(fresh)}\n`, "the new line must be on its own line, not glued to the fragment");

      const captured: string[] = [];
      const capturing = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
      const second = await replayJournal({ dir: l.journal, agents, engine: capturing, logger, clock: () => 1 });
      assert.deepEqual(captured, ["after-torn-tail"], "the new line is captured cleanly, not glued to the fragment");
      assert.deepEqual(second, { replayed: 1, kept: 1 });
      assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), '{"v":1,"id":"not-json\n', "the fragment is still kept, unchanged");
    });

    it("strips a trailing \\r before parsing (CRLF line endings)", async () => {
      const { l, agents, logger } = setup();
      const one = line("11111111-1111-4111-8111-111111111111", "crlf-one");
      const two = line("22222222-2222-4222-8222-222222222222", "crlf-two");
      writeFileSync(join(l.journal, "bernd.jsonl"), `${JSON.stringify(one)}\r\n${JSON.stringify(two)}\r\n`, { mode: 0o600 });
      const captured: string[] = [];
      const engine = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(captured, ["crlf-one", "crlf-two"]);
      assert.deepEqual(r, { replayed: 2, kept: 0 });
    });
  });

  // Round 2, finding 1: a per-file rename failure (e.g. Windows EBUSY/EPERM while the CLI holds the file
  // open) must never abort replay of the other files. Reproduced on Linux by pre-creating a directory at the
  // exact path `renameSync` would target (`<agent>.jsonl.replaying-<pid>`, using this test process's own
  // pid, since replay runs in the same process): `renameSync` onto an existing directory fails with EISDIR
  // — a plain, non-ENOENT error, the same shape a locked-file error would have. This avoids adding a
  // test-only rename-injection seam to replayJournal's production signature.
  describe("round 2, finding 1: per-file isolation on a rename failure", () => {
    it("skips a file whose rename fails and still replays another agent's file", async () => {
      const l = layout(mkdtempSync(join(tmpdir(), "p1b-journal-"))); mkdirSync(l.journal, { recursive: true });
      const cfg = defaults(); cfg.agents.bad = {}; cfg.agents.good = {};
      const agents = createAgentRegistry(cfg, l); agents.scaffold("bad"); agents.scaffold("good");
      const logger = createLogger({ file: l.logFile("core"), level: "debug", role: "core" });
      appendJournalLine(l.journal, { ...line("11111111-1111-4111-8111-111111111111", "bad-content"), agentId: "bad" });
      appendJournalLine(l.journal, { ...line("22222222-2222-4222-8222-222222222222", "good-content"), agentId: "good" });
      mkdirSync(join(l.journal, `bad.jsonl.replaying-${process.pid}`)); // blocks renameSync onto this exact path with EISDIR
      const warnings: string[] = [];
      const origWarn = logger.warn; logger.warn = (m, f) => { warnings.push(m); origWarn(m, f); };
      const captured: string[] = [];
      const engine = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
      const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(captured, ["good-content"], "capture was never attempted for the file whose rename failed");
      assert.equal(r.replayed, 1);
      assert.ok(r.kept >= 1, "the skipped file's line is counted as kept on a best-effort basis");
      assert.ok(warnings.some((w) => w === "journal: file skipped this start"));
      // bad.jsonl itself is left untouched (never renamed away) so it is retried on the next startup.
      assert.equal(readFileSync(join(l.journal, "bad.jsonl"), "utf8").includes("bad-content"), true);
      assert.equal(existsSync(join(l.journal, "good.jsonl")) && readFileSync(join(l.journal, "good.jsonl"), "utf8").length > 0, false);
    });
  });

  describe("I2: drainJournal", () => {
    it("replays a line appended while a pass is running, without a restart", async () => {
      const { l, agents, logger } = setup();
      appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "first"));
      const captured: string[] = [];
      const engine = { capture: (t: any) => {
        captured.push(t.messages[0].content);
        // the CLI journals while the first pass is running: bernd.jsonl was already renamed away, so this lands in a fresh file
        if (captured.length === 1) appendJournalLine(l.journal, line("22222222-2222-4222-8222-222222222222", "during-replay"));
        return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} };
      } } as any;
      const r = await drainJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(captured, ["first", "during-replay"]);
      assert.deepEqual(r, { replayed: 2, kept: 0, passes: 2 });
      assert.equal(existsSync(join(l.journal, "bernd.jsonl")), false);
    });

    it("stops after one pass when only kept lines remain, and counts them as the backlog", async () => {
      const { l, agents, logger } = setup();
      appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "refused"));
      let calls = 0;
      const engine = { capture: () => { calls += 1; return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 0, skipped: 0, reason: "busy" }), abort() {} }; } } as any;
      const r = await drainJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
      assert.deepEqual(r, { replayed: 0, kept: 1, passes: 1 });
      assert.equal(calls, 1, "a kept line is not retried within the same start unless new lines arrived");
    });

    it("is bounded by maxPasses when lines keep arriving", async () => {
      const { l, agents, logger } = setup();
      appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "x"));
      let n = 0;
      const engine = { capture: () => {
        n += 1; appendJournalLine(l.journal, line(`${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`, "more"));
        return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} };
      } } as any;
      const r = await drainJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 }, 3);
      assert.equal(r.passes, 3); assert.equal(r.replayed, 3); assert.equal(r.kept, 1, "the line appended during the last pass is the backlog");
    });
  });
});
