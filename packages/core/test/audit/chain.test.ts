import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAuditChain, hashLine, teeAuditSinks, ACTIVE_NAME, ANCHOR_NAME, GENESIS_HASH, type AuditChain } from "../../src/audit/chain.ts";
import type { AuditEvent } from "../../src/rbac/audit.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ev = (i: number): AuditEvent => ({ at: 1000 + i, actor: { user: "u", host: "h" }, action: "test.event", target: `t${i}`, detail: { i } });
function fresh(o: { maxBytes?: number } = {}): { dir: string; chain: AuditChain; file: string; read(): string[]; write(lines: string[], eol?: string): void } {
  const dir = tempDir("audit-chain-");
  const chain = createAuditChain({ dir, ...o });
  const file = path.join(dir, ACTIVE_NAME);
  return {
    dir, chain, file,
    read: () => readFileSync(file, "utf8").split("\n").filter((l) => l !== ""),
    write: (lines, eol = "\n") => writeFileSync(file, lines.map((l) => l + eol).join("")),
  };
}
const fill = (c: AuditChain, n: number): void => { for (let i = 0; i < n; i++) c.append(ev(i)); };
const codes = (c: AuditChain): string[] => c.verify().findings.map((f) => f.code);

describe("audit chain", () => {
  it("chains each line to the SHA-256 of the previous one, starting at the genesis hash", () => {
    const t = fresh(); fill(t.chain, 3);
    const lines = t.read(); const p = lines.map((l) => JSON.parse(l));
    assert.equal(p[0].prev, GENESIS_HASH);
    assert.equal(p[1].prev, hashLine(lines[0] as string));
    assert.equal(p[2].prev, hashLine(lines[1] as string));
    assert.deepEqual(p.map((x) => x.seq), [1, 2, 3]);
    assert.deepEqual(p[0].rec, ev(0));
    const v = t.chain.verify();
    assert.deepEqual([v.ok, v.records, v.files, v.lastSeq, v.lastHash, v.anchor], [true, 3, 1, 3, hashLine(lines[2] as string), { status: "match", seq: 3 }]);
  });

  it("an empty chain verifies", () => {
    const t = fresh();
    const v = t.chain.verify();
    assert.deepEqual([v.ok, v.records, v.lastHash, v.anchor.status], [true, 0, null, "absent"]);
  });

  it("detects a manipulated line in the middle (the next line no longer chains)", () => {
    const t = fresh(); fill(t.chain, 4);
    const l = t.read(); l[1] = (l[1] as string).replace('"i":1', '"i":99'); t.write(l);
    const v = t.chain.verify();
    assert.equal(v.ok, false);
    assert.deepEqual(v.findings.map((f) => [f.code, f.line]), [["hash-mismatch", 3]]);
  });

  it("detects a manipulated last line through the anchor", () => {
    const t = fresh(); fill(t.chain, 3);
    const l = t.read(); l[2] = (l[2] as string).replace('"i":2', '"i":99'); t.write(l);
    const v = t.chain.verify();
    assert.equal(v.ok, false); assert.deepEqual(codes(t.chain), ["anchor-mismatch"]); assert.equal(v.anchor.status, "mismatch");
  });

  it("detects a deleted line (hash break and sequence gap)", () => {
    const t = fresh(); fill(t.chain, 4);
    const l = t.read(); l.splice(1, 1); t.write(l);
    assert.deepEqual(codes(t.chain), ["hash-mismatch", "seq-gap"]);
  });

  it("detects a deleted first line", () => {
    const t = fresh(); fill(t.chain, 3);
    const l = t.read(); l.shift(); t.write(l);
    assert.deepEqual(codes(t.chain), ["prefix-missing"]);
  });

  it("detects a malformed line", () => {
    const t = fresh(); fill(t.chain, 3);
    const l = t.read(); l[1] = "not json"; t.write(l);
    assert.ok(codes(t.chain).includes("line-malformed"));
    assert.equal(t.chain.verify().ok, false);
  });

  it("detects truncation at the end through the anchor in its separate file", () => {
    const t = fresh(); fill(t.chain, 5);
    const l = t.read(); t.write(l.slice(0, 3)); // a perfectly valid chain of three lines
    const v = t.chain.verify();
    assert.equal(v.ok, false);
    assert.deepEqual(v.findings.map((f) => [f.code, f.seq]), [["truncated", 5]]);
    assert.equal(v.anchor.status, "ahead");
    assert.ok(existsSync(path.join(t.dir, ANCHOR_NAME)));
  });

  it("detects a removed active file and a removed anchor", () => {
    const t = fresh(); fill(t.chain, 2);
    rmSync(path.join(t.dir, ANCHOR_NAME));
    assert.deepEqual(codes(t.chain), ["anchor-missing"]);
    const u = fresh(); fill(u.chain, 2); rmSync(u.file);
    assert.deepEqual(codes(u.chain), ["truncated"]);
  });

  it("detects an invalid anchor", () => {
    const t = fresh(); fill(t.chain, 2);
    writeFileSync(path.join(t.dir, ANCHOR_NAME), "{}");
    assert.deepEqual(codes(t.chain), ["anchor-invalid"]);
  });

  it("an anchor one line behind (crash between append and anchor update) is fine", () => {
    const t = fresh(); fill(t.chain, 2);
    const anchorFile = path.join(t.dir, ANCHOR_NAME);
    const behind = JSON.stringify({ v: 1, seq: 1, hash: hashLine(t.read()[0] as string) });
    writeFileSync(anchorFile, behind);
    const v = t.chain.verify();
    assert.deepEqual([v.ok, v.anchor.status], [true, "behind"]);
    t.chain.append(ev(2)); // the writer carries on and moves the anchor forward
    assert.deepEqual([t.chain.verify().ok, t.chain.verify().anchor.status], [true, "match"]);
  });

  it("the writer refuses to append to a chain its anchor says was cut (fail closed)", () => {
    const t = fresh(); fill(t.chain, 4);
    t.write(t.read().slice(0, 2));
    assert.throws(() => t.chain.append(ev(9)), /shorter than its anchor/);
    assert.equal(t.read().length, 2);
  });

  it("rotation: the new file chains to the last hash of the old one and seq goes on", () => {
    const t = fresh(); fill(t.chain, 3);
    const lastHash = t.chain.verify().lastHash;
    const name = t.chain.rotate();
    assert.equal(name, "audit-chain.0000000001.jsonl");
    assert.equal(existsSync(t.file), false);
    assert.equal(t.chain.verify().ok, true); // a rotated chain alone still verifies against the anchor
    t.chain.append(ev(3));
    const first = JSON.parse(t.read()[0] as string);
    assert.deepEqual([first.seq, first.prev], [4, lastHash]);
    const v = t.chain.verify();
    assert.deepEqual([v.ok, v.files, v.records, v.lastSeq], [true, 2, 4, 4]);
    assert.equal(t.chain.rotate(), "audit-chain.0000000004.jsonl");
    assert.equal(t.chain.rotate(), null); // nothing active
  });

  it("rotation by size", () => {
    const t = fresh({ maxBytes: 600 }); fill(t.chain, 10);
    const rotated = readdirSync(t.dir).filter((n) => /^audit-chain\.\d{10}\.jsonl$/.test(n));
    assert.ok(rotated.length >= 2, `rotated: ${rotated.join(",")}`);
    const v = t.chain.verify();
    assert.deepEqual([v.ok, v.records, v.lastSeq], [true, 10, 10]);
  });

  it("detects a missing or tampered rotated file", () => {
    const t = fresh(); fill(t.chain, 2); t.chain.rotate(); fill(t.chain, 2); t.chain.rotate(); fill(t.chain, 2);
    const mid = path.join(t.dir, "audit-chain.0000000003.jsonl");
    const saved = readFileSync(mid);
    rmSync(mid);
    assert.deepEqual(codes(t.chain), ["hash-mismatch", "seq-gap"]);
    writeFileSync(mid, saved);
    assert.equal(t.chain.verify().ok, true);
    writeFileSync(mid, saved.toString("utf8").replace('"i":0', '"i":7'));
    assert.deepEqual(codes(t.chain), ["hash-mismatch"]);
    writeFileSync(mid, saved);
    rmSync(path.join(t.dir, "audit-chain.0000000001.jsonl"));
    assert.deepEqual(codes(t.chain), ["prefix-missing"]);
  });

  it("detects a rotated file renamed out of order", () => {
    const t = fresh(); fill(t.chain, 2); t.chain.rotate(); fill(t.chain, 2);
    writeFileSync(path.join(t.dir, "audit-chain.0000000009.jsonl"), readFileSync(path.join(t.dir, "audit-chain.0000000001.jsonl")));
    rmSync(path.join(t.dir, "audit-chain.0000000001.jsonl"));
    assert.ok(codes(t.chain).includes("file-name-mismatch"));
  });

  it("concurrent writers in several processes keep one intact chain", async () => {
    const dir = tempDir("audit-chain-conc-");
    const run = (tag: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", path.join(import.meta.dirname, "writer-child.ts"), dir, tag, "25"], { stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; child.stderr.on("data", (d) => { err += String(d); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("writer timed out")); }, 90_000);
      child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}: ${err}`)); });
    });
    await Promise.all(["a", "b", "c", "d"].map(run));
    const v = createAuditChain({ dir }).verify();
    assert.deepEqual([v.ok, v.records, v.lastSeq], [true, 100, 100], JSON.stringify(v.findings));
    const targets = readFileSync(path.join(dir, ACTIVE_NAME), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).rec.target);
    assert.equal(new Set(targets).size, 100);
  });

  it("two sinks on one directory in one process also serialise", () => {
    const dir = tempDir("audit-chain-two-");
    const a = createAuditChain({ dir }); const b = createAuditChain({ dir });
    for (let i = 0; i < 10; i++) (i % 2 ? a : b).append(ev(i));
    assert.deepEqual([a.verify().ok, a.verify().records], [true, 10]);
  });

  it("CRLF line endings (a file passed through Windows tooling) still verify, and appending stays on the chain", () => {
    const t = fresh(); fill(t.chain, 3);
    t.write(t.read(), "\r\n");
    assert.equal(t.chain.verify().ok, true);
    t.chain.append(ev(3));
    const v = t.chain.verify();
    assert.deepEqual([v.ok, v.records], [true, 4]);
  });

  it("an unterminated tail is reported by verify and set aside (not dropped) by the next append", () => {
    const t = fresh(); fill(t.chain, 2);
    writeFileSync(t.file, readFileSync(t.file, "utf8") + '{"seq":3,"prev":"ab');
    assert.deepEqual(codes(t.chain), ["torn-tail"]);
    t.chain.append(ev(2));
    assert.equal(t.chain.verify().ok, true);
    const torn = readdirSync(t.dir).filter((n) => n.includes(".torn-"));
    assert.equal(torn.length, 1);
    assert.match(readFileSync(path.join(t.dir, torn[0] as string), "utf8"), /^\{"seq":3/);
  });

  it("files are private on POSIX and findings never carry record content", () => {
    const t = fresh(); fill(t.chain, 2);
    if (process.platform !== "win32") for (const n of [ACTIVE_NAME, ANCHOR_NAME]) assert.equal(statSync(path.join(t.dir, n)).mode & 0o777, 0o600);
    const l = t.read(); l[0] = (l[0] as string).replace("t0", "SECRET-TARGET"); t.write(l);
    assert.ok(!JSON.stringify(t.chain.verify()).includes("SECRET-TARGET"));
  });

  it("securePath runs once per file", () => {
    const dir = tempDir("audit-chain-sec-"); const seen: string[] = [];
    const c = createAuditChain({ dir, securePath: (p) => seen.push(path.basename(p)) });
    fill(c, 3);
    assert.deepEqual(seen.filter((n) => n === ACTIVE_NAME), [ACTIVE_NAME]);
  });

  it("teeAuditSinks tries every sink and rethrows the first failure", () => {
    const got: string[] = [];
    const bad = { append() { throw new Error("boom"); } };
    const good = { append(e: AuditEvent) { got.push(e.action); } };
    assert.throws(() => teeAuditSinks(bad, good).append(ev(0)), /boom/);
    assert.deepEqual(got, ["test.event"]);
  });
});
