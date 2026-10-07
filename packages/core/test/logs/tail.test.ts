import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RpcError } from "../../src/rpc/errors.ts";
import { MAX_LINE_BYTES } from "../../src/logs/line-io.ts";
import { createRedactor } from "../../src/logs/redact.ts";
import { createTailService, type LogLines, type TailFilter, type TailService } from "../../src/logs/tail.ts";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const line = (ms: number, level: string, role: string, msg: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ at: new Date(T0 + ms).toISOString(), level, role, ...extra, msg })}\n`;

let dir: string;
let clock: number;
let sent: LogLines[];
let timers: Array<{ fn: () => void; ms: number; live: boolean }>;
let errors: unknown[];
const secret = "tail-secret-value-9876543210";
let svc: TailService;
const make = (o: { maxTails?: number } = {}): TailService => createTailService({
  dir, redactor: createRedactor({ secrets: () => [secret] }), notify: (_m, p) => { sent.push(structuredClone(p)); }, now: () => clock,
  setTimer: (fn, ms) => { const t = { fn: () => { t.live = false; fn(); }, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
  newId: (() => { let n = 0; return () => `tail-${++n}`; })(), onError: (e) => errors.push(e), ...o,
});
const put = (n: string, c: string): void => writeFileSync(path.join(dir, n), c);
const add = (n: string, c: string): void => appendFileSync(path.join(dir, n), c);
const msgs = (): string[] => sent.flatMap((s) => s.records.map((r) => r.msg));
const code = async (p: Promise<unknown>): Promise<{ error: string; reason?: string }> => {
  try { await p; } catch (e) { if (e instanceof RpcError) return { error: e.error, ...(e.reason ? { reason: e.reason } : {}) }; throw e; }
  throw new Error("did not throw");
};

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "d4-tail-")); mkdirSync(dir, { recursive: true }); clock = T0; sent = []; timers = []; errors = []; svc = make(); });
afterEach(() => { svc.stopAll(); rmSync(dir, { recursive: true, force: true }); assert.deepEqual(errors, []); });

describe("logs.tail", () => {
  it("starts from now: old lines are not delivered, appended ones are, redacted and attributed to their file", async () => {
    put("core.log", line(1, "info", "core", "old"));
    const t = await svc.start({});
    assert.equal(t.tailId, "tail-1");
    await svc.poll();
    assert.deepEqual(sent, []);
    add("core.log", line(2, "warn", "core", `new ${secret}`, { password: "p" }));
    put("module-x.log", line(3, "info", "module-x", "from a new file"));
    await svc.poll();
    assert.deepEqual(sent.map((s) => s.tailId), ["tail-1"]);
    assert.deepEqual(sent[0]!.records.map((r) => [r.msg, r.source]), [["new [REDACTED:secret]", "harness:core"], ["from a new file", "harness:module/x"]]);
    assert.deepEqual(sent[0]!.records[0]!.attrs, { password: "[REDACTED:key]" });
    assert.ok(!JSON.stringify(sent).includes(secret));
  });

  it("delivers only complete lines: a half line waits for its newline, and is delivered once", async () => {
    put("core.log", "");
    await svc.start({});
    const full = line(1, "info", "core", "whole");
    add("core.log", line(0, "info", "core", "first") + full.slice(0, 20));
    await svc.poll();
    assert.deepEqual(msgs(), ["first"]);
    add("core.log", full.slice(20));
    await svc.poll();
    assert.deepEqual(msgs(), ["first", "whole"]);
    await svc.poll();
    assert.deepEqual(msgs(), ["first", "whole"]);
  });

  it("a half line already at the end when the tail starts is not lost", async () => {
    const full = line(1, "info", "core", "straddles the start");
    put("core.log", line(0, "info", "core", "before") + full.slice(0, 15));
    await svc.start({});
    add("core.log", full.slice(15));
    await svc.poll();
    assert.deepEqual(msgs(), ["straddles the start"]);
  });

  it("applies the filters (level, components, text, streams)", async () => {
    put("core.log", ""); put("supervisor.log", ""); put("core.out.log", "");
    const tailFirst = async (f: TailFilter): Promise<string[]> => {
      sent = [];
      const t = await svc.start(f);
      add("core.log", line(1, "debug", "core", "core-debug") + line(2, "error", "core", "core-error needle"));
      add("supervisor.log", line(3, "info", "supervisor", "sup-info"));
      add("core.out.log", `${JSON.stringify({ ts: new Date(T0 + 4).toISOString(), level: "info", source: { kind: "harness", id: "core", version: null }, event: "process.output.line", msg: "out-line", stream: "stdout", attrs: { text: "t", untrusted: true } })}\n`);
      await svc.poll(); svc.stop(t.tailId);
      return msgs();
    };
    assert.deepEqual(await tailFirst({}), ["core-debug", "core-error needle", "sup-info", "out-line"]);
    assert.deepEqual(await tailFirst({ levelMin: "error" }), ["core-error needle"]);
    assert.deepEqual(await tailFirst({ components: ["harness:supervisor"] }), ["sup-info"]);
    assert.deepEqual(await tailFirst({ text: "NEEDLE" }), ["core-error needle"]);
    assert.deepEqual(await tailFirst({ streams: ["out"] }), ["out-line"]);
    assert.deepEqual(await tailFirst({ streams: ["diagnostic"], levelMin: "info" }), ["core-error needle", "sup-info"]);
  });

  it("counts corrupt and oversize lines and keeps going", async () => {
    put("core.log", "");
    await svc.start({});
    add("core.log", `garbage\n${line(1, "info", "core", "ok-1")}[1]\n${"z".repeat(MAX_LINE_BYTES + 100)}\n${line(2, "info", "core", "ok-2")}`);
    await svc.poll();
    assert.deepEqual(msgs(), ["ok-1", "ok-2"]);
    assert.equal(sent.reduce((n, s) => n + s.corruptLines, 0), 3);
  });

  it("survives a rotation between polls: the old file's unread tail first, then the new file from its start", async () => {
    put("core.log", line(0, "info", "core", "pre"));
    await svc.start({});
    add("core.log", line(1, "info", "core", "a1") + line(2, "info", "core", "a2"));
    renameSync(path.join(dir, "core.log"), path.join(dir, "core.log.1"));
    put("core.log", line(3, "info", "core", "b1") + line(4, "info", "core", "b2"));
    await svc.poll();
    assert.deepEqual(msgs(), ["a1", "a2", "b1", "b2"]);
    assert.deepEqual(sent[0]!.rotated, { gap: false });
    add("core.log", line(5, "info", "core", "b3"));
    await svc.poll();
    assert.deepEqual(msgs(), ["a1", "a2", "b1", "b2", "b3"]);
    assert.equal(sent[1]!.rotated, undefined);
  });

  it("a rotation in the middle of a half line completes the line from the renamed file", async () => {
    put("core.log", "");
    await svc.start({});
    const l = line(1, "info", "core", "split by rotation");
    add("core.log", l.slice(0, 25));
    await svc.poll();
    assert.deepEqual(msgs(), []);
    add("core.log", l.slice(25));
    renameSync(path.join(dir, "core.log"), path.join(dir, "core.log.1"));
    put("core.log", line(2, "info", "core", "next"));
    await svc.poll();
    assert.deepEqual(msgs(), ["split by rotation", "next"]);
  });

  it("two rotations between polls: the file that was read is found under its new name; one that was never seen is a reported gap", async () => {
    put("core.log", "");
    await svc.start({});
    add("core.log", line(1, "info", "core", "x1"));
    renameSync(path.join(dir, "core.log"), path.join(dir, "core.log.1"));
    put("core.log", line(2, "info", "core", "y1"));
    renameSync(path.join(dir, "core.log.1"), path.join(dir, "core.log.2"));
    renameSync(path.join(dir, "core.log"), path.join(dir, "core.log.1"));
    put("core.log", line(3, "info", "core", "z1"));
    await svc.poll();
    assert.deepEqual(msgs(), ["x1", "z1"], "y1 sat in a file that was never open: reported, not invented");
    assert.deepEqual(sent[0]!.rotated, { gap: false });
    // The old file is gone altogether (pruned): the gap is reported.
    sent = [];
    add("core.log", line(4, "info", "core", "z2"));
    rmSync(path.join(dir, "core.log.1")); rmSync(path.join(dir, "core.log.2"));
    renameSync(path.join(dir, "core.log"), path.join(dir, "core.log.1"));
    rmSync(path.join(dir, "core.log.1"));
    put("core.log", line(5, "info", "core", "w1"));
    await svc.poll();
    assert.deepEqual(msgs(), ["w1"]);
    assert.deepEqual(sent[0]!.rotated, { gap: true });
  });

  it("a truncated file (copy-truncate rotation) restarts from its start and reports a gap", async () => {
    put("core.log", line(0, "info", "core", "a".repeat(10)) + line(1, "info", "core", "b".repeat(10)));
    await svc.start({});
    truncateSync(path.join(dir, "core.log"), 0);
    add("core.log", line(2, "info", "core", "c"));
    await svc.poll();
    assert.deepEqual(msgs(), ["c"]);
    assert.deepEqual(sent[0]!.rotated, { gap: true });
  });

  it("caps one poll at 1000 records (the newest are kept, the rest is counted) and sends batches of at most 200", async () => {
    put("core.log", "");
    await svc.start({});
    add("core.log", Array.from({ length: 1500 }, (_, i) => line(i, "info", "core", `m${i}`)).join(""));
    await svc.poll();
    assert.equal(msgs().length, 1000);
    assert.equal(msgs()[0], "m500");
    assert.equal(msgs()[999], "m1499");
    assert.equal(sent.reduce((n, s) => n + s.dropped, 0), 500);
    assert.ok(sent.every((s) => s.records.length <= 200));
    assert.equal(sent.length, 5);
  });

  it("expires after its ttl: one `expired` notification, then silence, and the timer stops", async () => {
    put("core.log", "");
    await svc.start({}, { ttlMs: 5_000 });
    clock += 4_999;
    await svc.poll();
    assert.deepEqual(sent, []);
    clock += 1;
    await svc.poll();
    assert.deepEqual(sent, [{ tailId: "tail-1", records: [], corruptLines: 0, dropped: 0, ended: "expired" }]);
    assert.equal(svc.active(), 0);
    add("core.log", line(1, "info", "core", "after"));
    await svc.poll();
    assert.equal(sent.length, 1);
    assert.ok(timers.every((t) => !t.live), "no timer left running");
  });

  it("limits: at most 4 tails, a ttl in range, a valid filter", async () => {
    for (let i = 0; i < 4; i++) await svc.start({});
    assert.deepEqual(await code(svc.start({})), { error: "E_CONFLICT", reason: "too-many-tails" });
    svc.stopAll(); sent = [];
    for (const ttlMs of [0, 999, 3_600_001, 1.5]) assert.deepEqual(await code(svc.start({}, { ttlMs })), { error: "E_INVALID_PARAMS", reason: "ttl-invalid" }, String(ttlMs));
    assert.deepEqual(await code(svc.start({ levelMin: "loud" as never })), { error: "E_INVALID_PARAMS", reason: "level-invalid" });
    assert.deepEqual(await code(svc.start({ streams: ["payload" as never] })), { error: "E_INVALID_PARAMS", reason: "stream-invalid" });
    assert.equal(svc.active(), 0);
  });

  it("stop ends delivery; stopAll tells every tail the core is shutting down", async () => {
    put("core.log", "");
    const a = await svc.start({}); const b = await svc.start({});
    assert.equal(svc.stop(a.tailId), true);
    assert.equal(svc.stop(a.tailId), false);
    add("core.log", line(1, "info", "core", "x"));
    await svc.poll();
    assert.deepEqual(sent.map((s) => s.tailId), [b.tailId]);
    sent = [];
    svc.stopAll();
    assert.deepEqual(sent, [{ tailId: b.tailId, records: [], corruptLines: 0, dropped: 0, ended: "shutdown" }]);
    assert.equal(svc.active(), 0);
  });

  it("polls on its own timer while a tail exists, and not at all when none does", async () => {
    put("core.log", "");
    assert.equal(timers.length, 0);
    const t = await svc.start({});
    assert.equal(timers.filter((x) => x.live).length, 1);
    assert.equal(timers[0]!.ms, 500);
    add("core.log", line(1, "info", "core", "tick"));
    timers[0]!.fn();
    await svc.poll(); // joins the poll the timer started
    assert.deepEqual(msgs(), ["tick"]);
    assert.equal(timers.filter((x) => x.live).length, 1, "rescheduled");
    svc.stop(t.tailId);
    assert.equal(timers.filter((x) => x.live).length, 0, "cancelled with the last tail");
  });

  it("a missing logs directory is no error; files appearing later are picked up from their start", async () => {
    rmSync(dir, { recursive: true, force: true });
    await svc.start({});
    await svc.poll();
    mkdirSync(dir, { recursive: true });
    put("core.log", line(1, "info", "core", "first ever"));
    await svc.poll();
    assert.deepEqual(msgs(), ["first ever"]);
  });
});
