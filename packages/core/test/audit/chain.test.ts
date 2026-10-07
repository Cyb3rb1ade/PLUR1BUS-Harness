// B5: the audit hash chain. Every test works in a temp directory; no clock sleeps (the lock timeout is the only wall time).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAuditChain, hashLine, GENESIS, type AuditChain } from "../../src/audit/index.ts";
import type { AuditEvent } from "../../src/rbac/audit.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ev = (n: number, over: Partial<AuditEvent> = {}): AuditEvent => ({ at: 1000 + n, actor: { user: "u1", host: "h" }, action: "test.event", target: `t${n}`, detail: { n }, ...over });
const dirs: string[] = [];
function fresh(o: { maxBytes?: number } = {}): { dir: string; chain: AuditChain; active: string; anchor: string } {
  const dir = tempDir("p1b-chain-"); dirs.push(dir);
  const logs = join(dir, "logs");
  return { dir: logs, chain: createAuditChain({ dir: logs, ...o }), active: join(logs, "audit.chain.jsonl"), anchor: join(logs, "audit.chain.anchor") };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const lines = (p: string): string[] => readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
const codes = (r: { findings: { code: string }[] }): string[] => r.findings.map((f) => f.code);

describe("audit chain: append", () => {
  it("an empty chain verifies and creates no files", () => {
    const { chain, dir } = fresh();
    const r = chain.verify();
    assert.equal(r.ok, true); assert.equal(r.lines, 0); assert.equal(r.lastHash, null); assert.equal(r.anchor, "missing");
    assert.equal(existsSync(dir), false);
  });

  it("each line carries seq and the SHA-256 of the previous line's exact bytes; the first points at the genesis value", () => {
    const { chain, active } = fresh();
    for (let i = 1; i <= 3; i++) chain.append(ev(i));
    const ls = lines(active).map((l) => ({ raw: l, o: JSON.parse(l) as Record<string, unknown> }));
    assert.deepEqual(Object.keys(ls[0]!.o), ["at", "actor", "action", "target", "detail", "seq", "prev"]);
    assert.equal(ls[0]!.o["prev"], GENESIS);
    assert.equal(ls[1]!.o["prev"], hashLine(ls[0]!.raw));
    assert.equal(ls[2]!.o["prev"], hashLine(ls[1]!.raw));
    assert.deepEqual(ls.map((l) => l.o["seq"]), [1, 2, 3]);
    const r = chain.verify();
    assert.equal(r.ok, true); assert.equal(r.lines, 3); assert.equal(r.lastSeq, 3); assert.equal(r.lastHash, hashLine(ls[2]!.raw)); assert.equal(r.anchor, "match");
  });

  it("an event cannot inject seq or prev at the top level, and the chain survives a restart of the writer", () => {
    const a = fresh();
    a.chain.append({ ...ev(1), ...({ seq: 99, prev: "x" } as object) } as AuditEvent);
    const second = createAuditChain({ dir: a.dir });
    second.append(ev(2));
    const ls = lines(a.active).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(ls.map((l) => l["seq"]), [1, 2]);
    assert.equal(ls[0]!["prev"], GENESIS);
    assert.equal(second.verify().ok, true);
  });

  it("the sink adapter satisfies AuditSink", () => {
    const { chain, active } = fresh();
    chain.sink.append(ev(1));
    assert.equal(lines(active).length, 1);
  });
});

describe("audit chain: tampering", () => {
  const seed = (n: number) => { const f = fresh(); for (let i = 1; i <= n; i++) f.chain.append(ev(i)); return f; };

  it("a modified line in the middle is found at the line after it", () => {
    const { chain, active } = seed(5);
    const ls = lines(active);
    ls[1] = ls[1]!.replace('"t2"', '"tX"');
    writeFileSync(active, ls.join("\n") + "\n");
    const r = chain.verify();
    assert.equal(r.ok, false);
    assert.deepEqual(r.findings.map((f) => [f.code, f.line]), [["hash-mismatch", 3]]);
  });

  it("a modified last line is found through the anchor", () => {
    const { chain, active } = seed(3);
    const ls = lines(active);
    ls[2] = ls[2]!.replace('"t3"', '"tX"');
    writeFileSync(active, ls.join("\n") + "\n");
    const r = chain.verify();
    assert.equal(r.ok, false); assert.deepEqual(codes(r), ["anchor-mismatch"]); assert.equal(r.anchor, "mismatch");
  });

  it("a deleted line in the middle is a sequence gap and a hash break", () => {
    const { chain, active } = seed(5);
    const ls = lines(active); ls.splice(2, 1);
    writeFileSync(active, ls.join("\n") + "\n");
    const r = chain.verify();
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r).sort(), ["hash-mismatch", "seq-gap"]);
    assert.ok(r.findings.every((f) => f.line === 3));
  });

  it("an inserted forged line is found", () => {
    const { chain, active } = seed(3);
    const ls = lines(active);
    ls.splice(1, 0, JSON.stringify({ ...JSON.parse(ls[0]!), target: "forged" }));
    writeFileSync(active, ls.join("\n") + "\n");
    assert.equal(chain.verify().ok, false);
  });

  it("truncation at the end (one or several lines) is found through the anchor file", () => {
    for (const keep of [4, 2, 0]) {
      const { chain, active } = seed(5);
      const ls = lines(active).slice(0, keep);
      writeFileSync(active, ls.length ? ls.join("\n") + "\n" : "");
      const r = chain.verify();
      assert.equal(r.ok, false, `keep ${keep}`);
      assert.deepEqual(codes(r), ["anchor-mismatch"], `keep ${keep}`);
    }
  });

  it("a deleted anchor next to existing lines is a finding (fail closed)", () => {
    const { chain, anchor } = seed(2);
    rmSync(anchor);
    const r = chain.verify();
    assert.equal(r.ok, false); assert.deepEqual(codes(r), ["anchor-missing"]); assert.equal(r.anchor, "missing");
  });

  it("a garbage or blank line is reported, not thrown", () => {
    const { chain, active } = seed(3);
    const ls = lines(active); ls.splice(1, 0, "not json", " ");
    writeFileSync(active, ls.join("\n") + "\n");
    const r = chain.verify();
    assert.equal(r.ok, false); assert.ok(codes(r).includes("bad-line"));
  });

  it("a crash between line and anchor (anchor one line behind) is tolerated and reported as lag; two behind is not", () => {
    const { chain, active, anchor } = seed(3);
    const keep = readFileSync(anchor, "utf8");
    chain.append(ev(4));
    writeFileSync(anchor, keep);
    const lag = chain.verify();
    assert.equal(lag.ok, true); assert.equal(lag.anchor, "lag");
    chain.append(ev(5));
    writeFileSync(anchor, keep);
    const far = chain.verify();
    assert.equal(far.ok, false); assert.deepEqual(codes(far), ["anchor-mismatch"]);
    assert.equal(lines(active).length, 5);
  });

  it("an unterminated last line (torn write) fails closed, and the next append does not glue onto it", () => {
    const { chain, active } = seed(2);
    appendFileSync(active, '{"at":1,"actor"');
    assert.equal(chain.verify().ok, false);
    chain.append(ev(3));
    const raw = readFileSync(active, "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.equal(raw.split("\n").filter(Boolean).length, 4);
    const r = chain.verify();
    assert.equal(r.ok, false); assert.ok(codes(r).includes("bad-line"));
  });

  it("findings are capped, the result says so, and a huge line is skipped without being held in memory", () => {
    const { chain, active } = seed(1);
    const junk = Array.from({ length: 200 }, () => "x").join("\n");
    appendFileSync(active, junk + "\n" + "y".repeat(2 * 1024 * 1024) + "\n");
    const r = chain.verify();
    assert.equal(r.ok, false); assert.equal(r.findingsTruncated, true); assert.ok(r.findings.length <= 50);
  });
});

describe("audit chain: line endings", () => {
  it("a file converted to CRLF still verifies, and appending afterwards keeps the chain intact", () => {
    const { chain, active } = fresh();
    for (let i = 1; i <= 3; i++) chain.append(ev(i));
    writeFileSync(active, lines(active).join("\r\n") + "\r\n");
    assert.equal(chain.verify().ok, true);
    chain.append(ev(4));
    const r = chain.verify();
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.lines, 4);
  });

  it("the writer always terminates lines with LF", () => {
    const { chain, active } = fresh();
    chain.append(ev(1));
    assert.ok(!readFileSync(active, "utf8").includes("\r"));
  });
});

describe("audit chain: rotation", () => {
  const rotatedOf = (dir: string): string[] => readdirSync(dir).filter((f) => /^audit\.chain\.\d{6}\.jsonl$/.test(f)).sort();

  it("rotates at maxBytes; the new file continues from the last hash of the old one; verify spans all files", () => {
    const { chain, dir, active } = fresh({ maxBytes: 600 });
    for (let i = 1; i <= 12; i++) chain.append(ev(i));
    const files = rotatedOf(dir);
    assert.ok(files.length >= 2, files.join());
    const lastOfFirst = lines(join(dir, files[0]!)).at(-1)!;
    assert.equal(JSON.parse(lines(join(dir, files[1]!))[0]!).prev, hashLine(lastOfFirst));
    assert.ok(statSync(active).size <= 600);
    const r = chain.verify();
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.lines, 12); assert.equal(r.files, files.length + 1); assert.equal(r.anchor, "match");
  });

  it("a tampered rotated file and a missing rotated file are both found", () => {
    const a = fresh({ maxBytes: 400 });
    for (let i = 1; i <= 12; i++) a.chain.append(ev(i));
    const rotated = rotatedOf(a.dir);
    assert.ok(rotated.length >= 3);
    const mid = join(a.dir, rotated[1]!);
    const saved = readFileSync(mid, "utf8");
    writeFileSync(mid, saved.replace('"test.event"', '"test.evenT"'));
    assert.equal(a.chain.verify().ok, false);
    writeFileSync(mid, saved);
    assert.equal(a.chain.verify().ok, true);
    rmSync(mid);
    const r = a.chain.verify();
    assert.equal(r.ok, false); assert.ok(codes(r).includes("rotation-gap"));
  });

  it("deleting the oldest rotated file is found: the chain must start at the genesis value", () => {
    const a = fresh({ maxBytes: 400 });
    for (let i = 1; i <= 10; i++) a.chain.append(ev(i));
    rmSync(join(a.dir, rotatedOf(a.dir)[0]!));
    const r = a.chain.verify();
    assert.equal(r.ok, false); assert.ok(codes(r).includes("rotation-gap"));
  });

  it("a crash right after the rotation rename (no active file yet) verifies, and the next append continues the chain", () => {
    const a = fresh({ maxBytes: 100000 });
    for (let i = 1; i <= 3; i++) a.chain.append(ev(i));
    writeFileSync(join(a.dir, "audit.chain.000001.jsonl"), readFileSync(a.active)); rmSync(a.active);
    assert.equal(a.chain.verify().ok, true);
    a.chain.append(ev(4));
    const r = a.chain.verify();
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.lines, 4);
  });
});

describe("audit chain: concurrent writers", () => {
  it("truly simultaneous processes do not break the chain", async () => {
    const { dir } = fresh({ maxBytes: 4000 });
    mkdirSync(dir, { recursive: true });
    const { spawn } = await import("node:child_process");
    const worker = fileURLToPath(new URL("./chain-writer.ts", import.meta.url));
    const procs = 4, each = 40;
    const done = await Promise.all(Array.from({ length: procs }, (_, i) => new Promise<{ code: number | null; err: string }>((res) => {
      const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", worker, dir, String(i), String(each)], { stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; p.stderr.on("data", (d) => { err += String(d); });
      const t = setTimeout(() => p.kill(), 60000);
      p.on("close", (code) => { clearTimeout(t); res({ code, err }); });
    })));
    for (const d of done) assert.equal(d.code, 0, d.err);
    const r = createAuditChain({ dir, maxBytes: 4000 }).verify();
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.lines, procs * each);
  });

  it("a stale lock left by a dead process is taken over; a live fresh lock makes append fail after the timeout instead of hanging", () => {
    const { dir } = fresh();
    mkdirSync(join(dir, "audit.chain.lock"), { recursive: true });
    writeFileSync(join(dir, "audit.chain.lock", "owner"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    const c = createAuditChain({ dir, lockTimeoutMs: 2000 });
    c.append(ev(1));
    assert.equal(c.verify().ok, true);
    mkdirSync(join(dir, "audit.chain.lock"), { recursive: true });
    writeFileSync(join(dir, "audit.chain.lock", "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const t = createAuditChain({ dir, lockTimeoutMs: 150, lockStaleMs: 60000 });
    assert.throws(() => t.append(ev(2)), /audit lock/);
  });
});

describe("audit chain: files", { skip: process.platform === "win32" ? "POSIX modes" : false }, () => {
  it("chain and anchor are private to the user (0600)", () => {
    const { chain, active, anchor } = fresh();
    chain.append(ev(1));
    assert.equal(statSync(active).mode & 0o777, 0o600);
    assert.equal(statSync(anchor).mode & 0o777, 0o600);
  });
});
