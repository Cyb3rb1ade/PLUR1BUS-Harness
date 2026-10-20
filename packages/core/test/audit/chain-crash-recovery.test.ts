// The crash window of `append`: the line is fsynced first and the anchor is replaced second. A crash or SIGKILL between the two
// leaves a correctly chained line one past the anchor. The states below are built directly on disk (no process is killed).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAuditChain, hashLine, ACTIVE_NAME, ANCHOR_NAME, ANCHOR_ADVANCED_ACTION, type AuditChain } from "../../src/audit/chain.ts";
import type { AuditEvent } from "../../src/rbac/audit.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ev = (i: number): AuditEvent => ({ at: 1000 + i, actor: { user: "u", host: "h" }, action: "test.event", target: `t${i}`, detail: { i } });
const lines = (dir: string, name = ACTIVE_NAME): string[] => readFileSync(path.join(dir, name), "utf8").split("\n").filter((l) => l !== "");
const anchorOf = (dir: string): { v: number; seq: number; hash: string } => JSON.parse(readFileSync(path.join(dir, ANCHOR_NAME), "utf8"));
const setAnchor = (dir: string, seq: number, hash: string): void => writeFileSync(path.join(dir, ANCHOR_NAME), `${JSON.stringify({ v: 1, seq, hash })}\n`);

/** `n` lines written, then the anchor put back to the state "crashed after the line of seq `n` was fsynced". */
function crashedAfterLine(n: number, o: { maxBytes?: number } = {}): { dir: string; chain: AuditChain } {
  const dir = tempDir("audit-crash-");
  const chain = createAuditChain({ dir, ...o });
  for (let i = 0; i < n; i++) chain.append(ev(i));
  const all = [...readdirSync(dir).filter((f) => /^audit-chain\.\d{10}\.jsonl$/.test(f)).sort(), ACTIVE_NAME].flatMap((f) => lines(dir, f));
  if (n === 1) rmSync(path.join(dir, ANCHOR_NAME)); // the very first write: the anchor never existed
  else setAnchor(dir, n - 1, hashLine(all[n - 2] as string));
  return { dir, chain };
}

describe("audit chain: crash between the fsynced line and the anchor", () => {
  it("verify tolerates the state (anchor behind), and the next append moves the anchor up and says so in the chain", () => {
    const { dir, chain } = crashedAfterLine(3);
    const before = lines(dir);
    const v0 = chain.verify();
    assert.deepEqual([v0.ok, v0.anchor], [true, { status: "behind", seq: 2 }]);

    chain.append(ev(3));

    const after = lines(dir);
    assert.deepEqual(after.slice(0, 3), before, "no earlier line is rewritten");
    assert.equal(after.length, 5);
    const note = JSON.parse(after[3] as string);
    assert.deepEqual([note.seq, note.prev, note.rec.action, note.rec.target], [4, hashLine(before[2] as string), ANCHOR_ADVANCED_ACTION, ANCHOR_NAME]);
    assert.deepEqual([note.rec.detail.fromSeq, note.rec.detail.toSeq], [2, 3]);
    assert.deepEqual(JSON.parse(after[4] as string).rec, ev(3));
    assert.deepEqual(anchorOf(dir), { v: 1, seq: 5, hash: hashLine(after[4] as string) });
    const v = chain.verify();
    assert.deepEqual([v.ok, v.records, v.lastSeq, v.anchor], [true, 5, 5, { status: "match", seq: 5 }]);
    assert.deepEqual([v.reanchors, v.previousChains], [[], []], "a healed crash is not an era boundary");
  });

  it("the event that was being appended when the previous process died is not lost or doubled", () => {
    const { dir, chain } = crashedAfterLine(1);
    chain.append(ev(1));
    assert.deepEqual(lines(dir).map((l) => JSON.parse(l).rec.target), ["t0", ANCHOR_NAME, "t1"]);
    assert.equal(JSON.parse(lines(dir)[1] as string).rec.detail.fromSeq, 0);
    chain.append(ev(2));
    assert.equal(chain.verify().records, 4);
  });

  it("also heals when the line that missed the anchor is the first line of a fresh file after a rotation", () => {
    const dir = tempDir("audit-crash-rot-");
    const chain = createAuditChain({ dir });
    chain.append(ev(0)); chain.append(ev(1));
    chain.rotate();
    const rotatedLast = lines(dir, "audit-chain.0000000001.jsonl")[1] as string;
    chain.append(ev(2)); // seq 3 chains to the rotated file's last line
    setAnchor(dir, 2, hashLine(rotatedLast)); // the crash: the anchor never moved to seq 3
    chain.append(ev(3));
    const v = chain.verify();
    assert.deepEqual([v.ok, v.records, v.lastSeq, v.files, v.anchor.status], [true, 5, 5, 2, "match"]);
  });

  it("also heals in the line that rotation by size writes", () => {
    const { dir, chain } = crashedAfterLine(6, { maxBytes: 400 });
    chain.append(ev(6));
    const v = chain.verify();
    assert.deepEqual([v.ok, v.anchor.status], [true, "match"]);
    assert.equal(v.records, 8);
    assert.ok(readdirSync(dir).some((f) => /^audit-chain\.\d{10}\.jsonl$/.test(f)));
  });

  it("two writers racing on the healed state produce one note, not two", () => {
    const { dir } = crashedAfterLine(2);
    const a = createAuditChain({ dir }); const b = createAuditChain({ dir });
    a.append(ev(2)); b.append(ev(3));
    const actions = lines(dir).map((l) => JSON.parse(l).rec.action);
    assert.equal(actions.filter((x) => x === ANCHOR_ADVANCED_ACTION).length, 1);
    assert.equal(a.verify().ok, true);
  });

  it("an unterminated fragment after the missed line is set aside first; the anchor is then advanced", () => {
    const { dir, chain } = crashedAfterLine(2);
    writeFileSync(path.join(dir, ACTIVE_NAME), readFileSync(path.join(dir, ACTIVE_NAME), "utf8") + '{"seq":3,"prev":"ab'); // the next write also crashed mid-line
    chain.append(ev(2));
    assert.equal(chain.verify().ok, true);
    assert.equal(readdirSync(dir).filter((f) => f.includes(".torn-")).length, 1);
  });
});

describe("audit chain: what is not healed stays a refusal", () => {
  const refused = (dir: string, chain: AuditChain, re: RegExp): void => {
    const before = lines(dir); const anchor = readFileSync(path.join(dir, ANCHOR_NAME), "utf8");
    assert.throws(() => chain.append(ev(9)), re);
    assert.deepEqual(lines(dir), before);
    assert.equal(readFileSync(path.join(dir, ANCHOR_NAME), "utf8"), anchor, "the anchor is not touched on a refusal");
  };

  it("one line past the anchor, but the line does not chain to the anchor's hash", () => {
    const { dir, chain } = crashedAfterLine(3);
    const l = lines(dir); const last = JSON.parse(l[2] as string);
    l[2] = JSON.stringify({ ...last, prev: "f".repeat(64) });
    writeFileSync(path.join(dir, ACTIVE_NAME), l.map((x) => `${x}\n`).join(""));
    refused(dir, chain, /tail does not match the anchor/);
  });

  it("one line past the anchor with the right back-link, but the seq skips a number", () => {
    const { dir, chain } = crashedAfterLine(3);
    const l = lines(dir); const last = JSON.parse(l[2] as string);
    l[2] = JSON.stringify({ ...last, seq: 4 });
    writeFileSync(path.join(dir, ACTIVE_NAME), l.map((x) => `${x}\n`).join(""));
    refused(dir, chain, /tail does not match the anchor/);
  });

  it("the extra line is not a chain line at all", () => {
    const { dir, chain } = crashedAfterLine(3);
    const l = lines(dir); l[2] = JSON.stringify({ seq: 3, prev: JSON.parse(l[2] as string).prev, rec: "not an object" });
    writeFileSync(path.join(dir, ACTIVE_NAME), l.map((x) => `${x}\n`).join(""));
    refused(dir, chain, /last line is not a chain line/);
  });

  it("the anchor is one line AHEAD of the chain (the reverse of the crash window)", () => {
    const dir = tempDir("audit-crash-ahead-"); const chain = createAuditChain({ dir });
    chain.append(ev(0)); chain.append(ev(1)); chain.append(ev(2));
    writeFileSync(path.join(dir, ACTIVE_NAME), lines(dir).slice(0, 2).map((x) => `${x}\n`).join(""));
    refused(dir, chain, /shorter than its anchor/);
  });

  it("an absent anchor with more than the first line in the chain is not the first-write crash", () => {
    const { dir, chain } = crashedAfterLine(2);
    rmSync(path.join(dir, ANCHOR_NAME));
    const before = lines(dir);
    assert.throws(() => chain.append(ev(9)), /anchor is missing/);
    assert.deepEqual(lines(dir), before);
  });

  it("the anchored line was altered while the anchor trails (the tail still chains to the anchor's hash, but that line no longer hashes to it)", () => {
    const { dir, chain } = crashedAfterLine(3);
    const l = lines(dir); l[1] = (l[1] as string).replace('"i":1', '"i":99');
    writeFileSync(path.join(dir, ACTIVE_NAME), l.map((x) => `${x}\n`).join(""));
    refused(dir, chain, /tail does not match the anchor/);
  });
});
