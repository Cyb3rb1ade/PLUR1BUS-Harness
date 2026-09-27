import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import type { JournalLine } from "@plur1bus/rpc-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { appendJournalLine } from "../src/journal.ts";
import { createLogger, type HarnessLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";
import { startJournalReplay, type JournalReplayStatus } from "../src/replay.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const caller = { channel: "cli" as const, accountId: "h", userId: "u" };
const line = (n: number): JournalLine => ({ v: 1, id: `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`, at: 1, agentId: "bernd", sessionKey: "s1", caller, messages: [{ role: "user", content: `line ${n}` }] });
const ok = () => ({ id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} });

const loggers: HarnessLogger[] = [];
function setup(lines: number) {
  const l = layout(tempDir("p1b-replay-")); mkdirSync(l.journal, { recursive: true });
  const cfg = defaults(); cfg.agents.bernd = {}; const agents = createAgentRegistry(cfg, l); agents.scaffold("bernd");
  const logger = createLogger({ file: l.logFile("core"), level: "debug", role: "core" }); loggers.push(logger);
  for (let i = 1; i <= lines; i++) appendJournalLine(l.journal, line(i));
  return { l, agents, logger };
}

describe("startJournalReplay", () => {
  after(() => Promise.all(loggers.splice(0).map((lg) => lg.close())));

  it("an empty journal is done at once with zeros", async () => {
    const { l, agents, logger } = setup(0); let seen: JournalReplayStatus | null = null;
    const r = startJournalReplay({ dir: l.journal, agents, engine: { capture: () => { throw new Error("no capture expected"); } } as any, logger, clock: () => 7, signal: new AbortController().signal, onDone: (s) => { seen = s; } });
    assert.deepEqual(r.status(), { state: "done", replayed: 0, kept: 0, passes: 0, startedAt: 7, finishedAt: 7 });
    assert.deepEqual(seen, r.status());
    await r.done;
  });

  it("reports replaying with live progress, then done with the drain's counts", async () => {
    const { l, agents, logger } = setup(3);
    let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
    let calls = 0;
    const engine = { capture: () => { calls += 1; return calls === 2 ? { ...ok(), done: gate.then(() => ({ stored: 1, skipped: 0 })) } : ok(); } } as any;
    let t = 10; let seen: JournalReplayStatus | null = null;
    const r = startJournalReplay({ dir: l.journal, agents, engine, logger, clock: () => t, signal: new AbortController().signal, onDone: (s) => { seen = s; } });
    assert.equal(r.status().state, "replaying"); assert.equal(r.status().startedAt, 10); assert.equal(r.status().finishedAt, null);
    while (calls < 2) await new Promise((res) => setImmediate(res));
    assert.equal(r.status().replayed, 1, "a replayed line counts before the pass ends");
    t = 20; release(); await r.done;
    assert.deepEqual(r.status(), { state: "done", replayed: 3, kept: 0, passes: 1, startedAt: 10, finishedAt: 20 });
    assert.deepEqual(seen, r.status());
  });

  it("is aborted by the signal between lines and keeps the rest", async () => {
    const { l, agents, logger } = setup(4);
    const ac = new AbortController();
    const engine = { capture: () => { ac.abort(); return ok(); } } as any;
    const r = startJournalReplay({ dir: l.journal, agents, engine, logger, clock: () => 1, signal: ac.signal });
    await r.done;
    assert.deepEqual({ ...r.status(), startedAt: 0, finishedAt: 0 }, { state: "aborted", replayed: 1, kept: 3, passes: 1, startedAt: 0, finishedAt: 0 });
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8").trim().split("\n").length, 3);
  });

  it("a replay that throws is failed and done still resolves", async () => {
    const { l, agents, logger } = setup(1);
    // The journal path is a file: listing it throws.
    const r = startJournalReplay({ dir: join(l.journal, "bernd.jsonl"), agents, engine: { capture: ok } as any, logger, clock: () => 1, signal: new AbortController().signal });
    await r.done;
    assert.equal(r.status().state, "failed"); assert.equal(r.status().finishedAt, 1);
  });

  it("logs nothing once its logger is detached", async () => {
    const { l, agents, logger } = setup(3);
    let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
    const engine = { capture: () => ({ ...ok(), done: gate.then(() => ({ stored: 1, skipped: 0 })) }) } as any;
    const r = startJournalReplay({ dir: l.journal, agents, engine, logger, clock: () => 1, signal: new AbortController().signal });
    while (!readdirSync(l.journal).some((f) => f.includes(".replaying-"))) await new Promise((res) => setImmediate(res));
    r.detachLogger();
    const before = statSync(l.logFile("core")).size;
    release(); await r.done;
    assert.equal(statSync(l.logFile("core")).size, before);
  });
});
