import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RpcError } from "../../src/rpc/errors.ts";
import { createLogQuery, type LogQueryParams, type LogQueryResult } from "../../src/logs/query.ts";
import { createRedactor } from "../../src/logs/redact.ts";
import { MAX_LINE_BYTES } from "../../src/logs/line-io.ts";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const legacy = (ms: number, level: string, role: string, msg: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ at: iso(ms), level, role, ...extra, msg })}\n`;

let dir: string;
let secret: string;
const q = (o: { maxScanBytes?: number; blockBytes?: number } = {}) => createLogQuery({ dir, redactor: createRedactor({ secrets: () => [secret] }), ...o }).query;
const put = (name: string, content: string): void => writeFileSync(path.join(dir, name), content);
const add = (name: string, content: string): void => appendFileSync(path.join(dir, name), content);
const msgs = (r: LogQueryResult): string[] => r.records.map((x) => x.msg);
async function pageAll(p: LogQueryParams, o: Parameters<typeof q>[0] = {}, hook?: (page: number) => void): Promise<LogQueryResult[]> {
  const pages: LogQueryResult[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const r = await q(o)({ ...p, ...(cursor ? { cursor } : {}) });
    pages.push(r);
    hook?.(i);
    if (!r.cursor) return pages;
    cursor = r.cursor;
  }
  throw new Error("cursor never ended");
}
const code = async (p: Promise<unknown>): Promise<{ error: string; reason?: string }> => {
  try { await p; } catch (e) { if (e instanceof RpcError) return { error: e.error, ...(e.reason ? { reason: e.reason } : {}) }; throw e; }
  throw new Error("did not throw");
};

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "d4-query-")); mkdirSync(dir, { recursive: true }); secret = "zq-secret-value-0123456789"; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("logs.query: reading", () => {
  it("merges the chains newest first, with the source key of each file", async () => {
    put("core.log", legacy(10, "info", "core", "c1") + legacy(40, "info", "core", "c2"));
    put("supervisor.log", legacy(20, "warn", "supervisor", "s1") + legacy(30, "info", "supervisor", "s2"));
    put("module-memory.log", legacy(25, "info", "module-memory", "m1"));
    const r = await q()({});
    assert.deepEqual(msgs(r), ["c2", "s2", "m1", "s1", "c1"]);
    assert.deepEqual(r.records.map((x) => x.source), ["harness:core", "harness:supervisor", "harness:module/memory", "harness:supervisor", "harness:core"]);
    assert.equal(r.cursor, null);
    assert.equal(r.corruptLines, 0);
    assert.equal(r.records[0]!.ts, iso(40));
  });

  it("reads rotated files as part of their chain (file, file.1, file.2) and ignores unrelated names", async () => {
    put("core.log.2", legacy(1, "info", "core", "oldest") + legacy(2, "info", "core", "old"));
    put("core.log.1", legacy(3, "info", "core", "mid"));
    put("core.log", legacy(4, "info", "core", "new"));
    put("core.log.bak", legacy(5, "info", "core", "bak"));
    put("notes.txt", "x\n");
    put("core.log.0", legacy(6, "info", "core", "zero"));
    assert.deepEqual(msgs(await q()({})), ["new", "mid", "old", "oldest"]);
  });

  it("normalizes the D111 shape, keeps the legacy free fields as redacted attrs, and flags a source that does not match its file", async () => {
    put("core.log",
      `${JSON.stringify({ ts: iso(5), level: "warn", source: { kind: "harness", id: "core", version: null }, event: "core.config.fallback", msg: "fallback", trace_id: "ab", agent: "bernd", attrs: { reason: "x" } })}\n` +
      `${JSON.stringify({ ts: iso(6), level: "info", source: { kind: "provider", id: "openai", version: null }, event: "provider.rate.limited", msg: "claims to be a provider" })}\n` +
      legacy(7, "info", "core", "ready", { instanceId: "i-1", password: "hunter2", err: { message: `boom ${secret}` } }));
    const r = await q()({});
    const [c, claim, ready] = [r.records[2]!, r.records[1]!, r.records[0]!];
    assert.equal(c.event, "core.config.fallback"); assert.equal(c.agent, "bernd"); assert.equal(c.trace_id, "ab"); assert.deepEqual(c.attrs, { reason: "x" }); assert.equal(c.attributed, true);
    assert.equal(claim.attributed, false); assert.equal(claim.source, "harness:core");
    assert.deepEqual(ready.attrs, { instanceId: "i-1", password: "[REDACTED:key]" });
    assert.deepEqual(ready.err, { message: "boom [REDACTED:secret]" });
  });

  it("never returns a raw secret, whatever field it sits in", async () => {
    put("core.log", legacy(1, "error", "core", `failed with token=${secret} and Bearer abcdefgh12345678`, { url: `https://u:p@h.test/x?key=${secret}`, nested: { list: [secret, { apiKey: "k" }] } }));
    const all = JSON.stringify((await q()({})).records);
    assert.ok(!all.includes(secret) && !all.includes("abcdefgh12345678") && !all.includes("u:p@") && !all.includes('"k"'), all);
  });

  it("does not expose payload.log, symlinks or non-regular files", async () => {
    put("payload.log", legacy(1, "info", "payload", "prompt text"));
    put("core.log", legacy(2, "info", "core", "ok"));
    put("outside.txt", legacy(3, "info", "outside", "outside"));
    let linked = true;
    try { symlinkSync(path.join(dir, "outside.txt"), path.join(dir, "evil.log")); } catch { linked = false; }
    mkdirSync(path.join(dir, "dir.log"));
    assert.deepEqual(msgs(await q()({})), ["ok"]);
    assert.ok(linked || process.platform === "win32");
  });

  it("returns an empty result for a missing logs directory", async () => {
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(await q()({}), { records: [], cursor: null, corruptLines: 0, scannedBytes: 0, truncated: false });
  });

  it("audit lines only when the audit stream is asked for, normalized (at epoch ms, action, actor)", async () => {
    put("core.log", legacy(10, "info", "core", "diag"));
    put("audit.log", `${JSON.stringify({ at: T0 + 20, actor: { user: "local-owner", host: "local" }, action: "config.set", target: "core.logLevel", detail: { key: "core.logLevel", new: "debug", token: "t" } })}\n`);
    assert.deepEqual(msgs(await q()({})), ["diag"]);
    const r = await q()({ streams: ["audit"] });
    assert.equal(r.records.length, 1);
    assert.deepEqual([r.records[0]!.event, r.records[0]!.msg, r.records[0]!.principal, r.records[0]!.stream, r.records[0]!.source, r.records[0]!.ts], ["config.set", "core.logLevel", "local-owner", "audit", "harness:audit", iso(20)]);
    assert.deepEqual(r.records[0]!.attrs, { detail: { key: "core.logLevel", new: "debug", token: "[REDACTED:key]" }, host: "local" });
    assert.deepEqual(msgs(await q()({ streams: ["audit", "diagnostic"] })), ["core.logLevel", "diag"]);
  });

  it("wrapped child output (the .out.log files) is its own stream", async () => {
    put("core.log", legacy(1, "info", "core", "own"));
    put("core.out.log", `${JSON.stringify({ ts: iso(2), level: "info", source: { kind: "harness", id: "core", version: null }, event: "process.output.line", msg: "wrapped", stream: "stderr", attrs: { text: "hello", untrusted: true } })}\n`);
    const r = await q()({});
    assert.deepEqual(r.records.map((x) => [x.msg, x.stream, x.iostream]), [["wrapped", "out", "stderr"], ["own", "diagnostic", undefined]]);
    assert.deepEqual(msgs(await q()({ streams: ["out"] })), ["wrapped"]);
  });
});

describe("logs.query: damaged input", () => {
  it("ignores a half last line and keeps reading before it", async () => {
    put("core.log", legacy(1, "info", "core", "a") + legacy(2, "info", "core", "b") + '{"at":"2026-10-01T00:00:00.003Z","level":"info","role":"core","msg":"hal');
    const r = await q()({});
    assert.deepEqual(msgs(r), ["b", "a"]);
    assert.equal(r.corruptLines, 0, "a writer's half line is not corruption");
  });

  it("counts corrupt, shapeless and oversize lines instead of failing", async () => {
    put("core.log",
      legacy(1, "info", "core", "good-1") + "not json at all\n" + "[1,2,3]\n" + '{"at":"nope","level":"info","msg":"bad ts"}\n' +
      '{"at":"2026-10-01T00:00:00.002Z","level":"loud","msg":"bad level"}\n' + '{"at":"2026-10-01T00:00:00.002Z","level":"info"}\n' +
      `${"x".repeat(MAX_LINE_BYTES + 5)}\n` + legacy(3, "info", "core", "good-2"));
    const r = await q({ blockBytes: 4096 })({});
    assert.deepEqual(msgs(r), ["good-2", "good-1"]);
    assert.equal(r.corruptLines, 6);
  });

  it("handles CRLF files and an empty or whitespace-only file", async () => {
    put("core.log", legacy(1, "info", "core", "a").replace("\n", "\r\n") + legacy(2, "info", "core", "b").replace("\n", "\r\n"));
    put("supervisor.log", "");
    put("module-x.log", "\n\n\n");
    assert.deepEqual(msgs(await q()({})), ["b", "a"]);
  });

  it("truncates an over-long msg and drops oversize attrs, flagging both", async () => {
    put("core.log", legacy(1, "info", "core", "word ".repeat(1000), { blob: "word ".repeat(4000) }));
    const [r] = (await q()({})).records;
    assert.equal(Buffer.byteLength(r!.msg), 2048);
    assert.deepEqual(r!.attrs, { truncated: true, bytes: Buffer.byteLength(JSON.stringify({ blob: "word ".repeat(4000) })) });
    assert.equal(r!.truncated, true);
  });
});

describe("logs.query: filters", () => {
  beforeEach(() => {
    put("core.log",
      legacy(1, "debug", "core", "d-core") + legacy(2, "info", "core", "i-core needle") + legacy(3, "warn", "core", "w-core") + legacy(4, "error", "core", "e-core") + legacy(5, "fatal", "core", "f-core"));
    put("supervisor.log", legacy(2, "info", "supervisor", "i-sup") + legacy(6, "warn", "supervisor", `w-sup ${secret}`));
    put("module-memory.log", legacy(3, "info", "module-memory", "i-mem Needle") + legacy(7, "error", "module-memory", "e-mem"));
    put("module-other.log", legacy(8, "info", "module-other", "i-other"));
  });

  it("levelMin", async () => {
    assert.deepEqual(msgs(await q()({ levelMin: "error" })), ["e-mem", "f-core", "e-core"]);
    assert.deepEqual(msgs(await q()({ levelMin: "fatal" })), ["f-core"]);
    assert.equal((await q()({ levelMin: "debug" })).records.length, 10);
  });

  it("since and until are inclusive", async () => {
    assert.deepEqual(msgs(await q()({ since: iso(3), until: iso(5) })).sort(), ["e-core", "f-core", "i-mem Needle", "w-core"].sort());
    assert.deepEqual(msgs(await q()({ since: iso(8) })), ["i-other"]);
    assert.deepEqual(msgs(await q()({ until: iso(1) })), ["d-core"]);
    assert.deepEqual(msgs(await q()({ since: "2026-10-01T02:00:00.003+02:00", until: "2026-10-01T02:00:00.003+02:00" })).sort(), ["i-mem Needle", "w-core"].sort());
  });

  it("components: exact key, bare kind, a /-prefix, several at once; no match is empty", async () => {
    assert.deepEqual(msgs(await q()({ components: ["harness:core"] })).length, 5);
    assert.deepEqual(msgs(await q()({ components: ["harness:module/memory"] })), ["e-mem", "i-mem Needle"]);
    assert.deepEqual(msgs(await q()({ components: ["harness:module"] })), ["i-other", "e-mem", "i-mem Needle"]);
    assert.equal((await q()({ components: ["harness"] })).records.length, 10);
    assert.deepEqual(msgs(await q()({ components: ["harness:supervisor", "harness:module/other"] })), ["i-other", "w-sup [REDACTED:secret]", "i-sup"]);
    assert.deepEqual((await q()({ components: ["provider"] })).records, []);
  });

  it("text: case-insensitive substring, over redacted text only (a removed secret cannot be searched for)", async () => {
    assert.deepEqual(msgs(await q()({ text: "NEEDLE" })), ["i-mem Needle", "i-core needle"]);
    assert.deepEqual((await q()({ text: secret })).records, []);
    assert.deepEqual((await q()({ text: secret.slice(0, 12) })).records, []);
    assert.deepEqual(msgs(await q()({ text: "[redacted:secret]" })), ["w-sup [REDACTED:secret]"]);
  });

  it("combinations: level + component + text + range", async () => {
    assert.deepEqual(msgs(await q()({ levelMin: "info", components: ["harness:core", "harness:module/memory"], text: "needle", since: iso(2), until: iso(3) })), ["i-mem Needle", "i-core needle"]);
    assert.deepEqual(msgs(await q()({ levelMin: "warn", components: ["harness:module"], since: iso(0), until: iso(7) })), ["e-mem"]);
    assert.deepEqual((await q()({ levelMin: "fatal", text: "sup" })).records, []);
  });

  it("limit applies after filtering", async () => {
    const r = await q()({ levelMin: "info", limit: 3 });
    assert.equal(r.records.length, 3);
    assert.notEqual(r.cursor, null);
  });
});

describe("logs.query: parameters", () => {
  it("rejects bad input with E_INVALID_PARAMS and a reason", async () => {
    const run = (p: LogQueryParams) => code(q()(p));
    assert.deepEqual(await run({ since: "yesterday" }), { error: "E_INVALID_PARAMS", reason: "since-invalid" });
    assert.deepEqual(await run({ until: "2026-10-01" }), { error: "E_INVALID_PARAMS", reason: "until-invalid" });
    assert.deepEqual(await run({ since: "2026-10-02T00:00:00Z", until: "2026-10-01T00:00:00Z" }), { error: "E_INVALID_PARAMS", reason: "range-invalid" });
    assert.deepEqual(await run({ levelMin: "loud" as never }), { error: "E_INVALID_PARAMS", reason: "level-invalid" });
    assert.deepEqual(await run({ components: ["not a key"] }), { error: "E_INVALID_PARAMS", reason: "component-invalid" });
    assert.deepEqual(await run({ components: Array.from({ length: 17 }, () => "harness") }), { error: "E_INVALID_PARAMS", reason: "component-invalid" });
    assert.deepEqual(await run({ text: "" }), { error: "E_INVALID_PARAMS", reason: "text-invalid" });
    assert.deepEqual(await run({ text: "x".repeat(257) }), { error: "E_INVALID_PARAMS", reason: "text-invalid" });
    assert.deepEqual(await run({ streams: ["payload" as never] }), { error: "E_INVALID_PARAMS", reason: "stream-invalid" });
    assert.deepEqual(await run({ limit: 0 }), { error: "E_INVALID_PARAMS", reason: "limit-invalid" });
    assert.deepEqual(await run({ limit: 1001 }), { error: "E_INVALID_PARAMS", reason: "limit-invalid" });
    for (const cursor of ["", "!!", "e30", Buffer.from('{"t":"x","c":"a","h":"0"}').toString("base64url"), "a".repeat(600)]) assert.deepEqual(await run({ cursor }), { error: "E_INVALID_PARAMS", reason: "cursor-invalid" }, cursor);
  });

  it("stops on an aborted signal", async () => {
    put("core.log", legacy(1, "info", "core", "a"));
    const ac = new AbortController(); ac.abort(new Error("gone"));
    await assert.rejects(q()({}, ac.signal), /gone/);
  });
});

describe("logs.query: cursor stability", () => {
  const seed = (n: number): string[] => {
    const all: string[] = [];
    let core = "", sup = "";
    for (let i = 0; i < n; i++) {
      const ms = Math.floor(i / 3) * 5; // three lines share every timestamp, across two chains
      if (i % 3 === 2) { sup += legacy(ms, "info", "supervisor", `s${i}`); } else core += legacy(ms, "info", "core", `c${i}`);
      all.push(i % 3 === 2 ? `s${i}` : `c${i}`);
    }
    put("core.log", core); put("supervisor.log", sup);
    return all;
  };
  const flat = (pages: LogQueryResult[]): string[] => pages.flatMap(msgs);

  it("pages through everything exactly once, equal timestamps included, at several page sizes", async () => {
    const all = seed(250);
    const want = [...all].sort();
    for (const limit of [1, 7, 100, 1000]) {
      const got = flat(await pageAll({ limit }));
      assert.equal(got.length, 250, `limit ${limit}`);
      assert.deepEqual([...got].sort(), want, `limit ${limit}`);
    }
    // the order is stable: the same query twice pages identically
    assert.deepEqual(flat(await pageAll({ limit: 13 })), flat(await pageAll({ limit: 13 })));
  });

  it("a page boundary inside a run of identical timestamps loses and repeats nothing in the same chain", async () => {
    put("core.log", Array.from({ length: 30 }, (_, i) => legacy(100, "info", "core", `same-${i}`)).join(""));
    const got = flat(await pageAll({ limit: 4 }));
    assert.deepEqual([...got].sort(), Array.from({ length: 30 }, (_, i) => `same-${i}`).sort());
  });

  it("new lines appended between pages do not disturb the older pages", async () => {
    seed(60);
    const first = await q()({ limit: 20 });
    add("core.log", legacy(10_000, "info", "core", "late-1") + legacy(10_001, "info", "core", "late-2"));
    add("supervisor.log", legacy(10_002, "info", "supervisor", "late-3"));
    const rest = await pageAll({ limit: 20, cursor: first.cursor! });
    const got = [...msgs(first), ...flat(rest)];
    assert.equal(got.length, 60);
    assert.ok(!got.some((m) => m.startsWith("late")));
    assert.equal(new Set(got).size, 60);
  });

  it("a rotation between pages (file -> file.1, a new file) loses and repeats nothing", async () => {
    seed(60);
    const first = await q()({ limit: 20 });
    renameSync(path.join(dir, "core.log"), path.join(dir, "core.log.1"));
    renameSync(path.join(dir, "supervisor.log"), path.join(dir, "supervisor.log.1"));
    put("core.log", legacy(9_000, "info", "core", "after-rotation"));
    const rest = await pageAll({ limit: 20, cursor: first.cursor! });
    const got = [...msgs(first), ...flat(rest)];
    assert.equal(got.length, 60);
    assert.equal(new Set(got).size, 60);
    assert.ok(!got.includes("after-rotation"));
  });

  it("a cursor whose line was pruned still continues from its time", async () => {
    seed(30);
    const first = await q()({ limit: 10 });
    const rows = (await q()({})).records;
    const keep = rows.slice(10);
    rmSync(path.join(dir, "core.log")); rmSync(path.join(dir, "supervisor.log"));
    let core = "", sup = "";
    for (const r of [...keep].reverse()) { const l = legacy(Date.parse(r.ts) - T0, "info", r.source === "harness:core" ? "core" : "supervisor", r.msg); if (r.source === "harness:core") core += l; else sup += l; }
    put("core.log", core); put("supervisor.log", sup);
    const got = [...msgs(first), ...flat(await pageAll({ limit: 10, cursor: first.cursor! }))];
    assert.equal(got.length, 30);
  });
});

describe("logs.query: big files stream, they are not read whole", () => {
  it("a page from a 200k-line file reads a bounded number of bytes, at the tail and from a cursor in the middle", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 200_000; i++) lines.push(legacy(i * 10, "info", "core", `line-${i}`, { pad: "p".repeat(40) }));
    put("core.log", lines.join(""));
    const tail = await q()({ limit: 5 });
    assert.deepEqual(msgs(tail), ["line-199999", "line-199998", "line-199997", "line-199996", "line-199995"]);
    assert.ok(tail.scannedBytes < 512 * 1024, `tail scanned ${tail.scannedBytes}`);
    const mid = await q()({ until: iso(100_000 * 10), limit: 3 });
    assert.deepEqual(msgs(mid), ["line-100000", "line-99999", "line-99998"]);
    assert.ok(mid.scannedBytes < 512 * 1024, `mid scanned ${mid.scannedBytes}`);
    const next = await q()({ until: iso(100_000 * 10), limit: 3, cursor: mid.cursor! });
    assert.deepEqual(msgs(next), ["line-99997", "line-99996", "line-99995"]);
    assert.ok(next.scannedBytes < 512 * 1024, `cursor page scanned ${next.scannedBytes}`);
    const since = await q()({ since: iso(199_990 * 10), limit: 1000 });
    assert.equal(since.records.length, 10);
    assert.ok(since.scannedBytes < 512 * 1024, `since scanned ${since.scannedBytes}`);
  });

  it("the scan budget ends a call that finds nothing, with a cursor that continues", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) lines.push(legacy(i, "info", "core", i === 3 ? "needle" : `filler-${i}`));
    put("core.log", lines.join(""));
    const first = await q({ maxScanBytes: 256 * 1024 })({ text: "needle", limit: 5 });
    assert.equal(first.truncated, true);
    assert.deepEqual(first.records, []);
    assert.notEqual(first.cursor, null);
    let cursor = first.cursor!, found: string[] = [], hops = 0;
    while (cursor && hops++ < 100) {
      const r = await q({ maxScanBytes: 256 * 1024 })({ text: "needle", limit: 5, cursor });
      found = found.concat(msgs(r));
      if (!r.cursor) break;
      cursor = r.cursor;
    }
    assert.deepEqual(found, ["needle"]);
  });
});
