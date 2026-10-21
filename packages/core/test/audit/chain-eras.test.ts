// Era boundaries: `plur1bus audit reanchor` (Rust) sets the old chain aside as `*.pre-reanchor-<ms>` and starts a new chain whose
// first line is an `audit.chain.reanchored` event. The states below are built the way that command leaves them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateResult } from "@plur1bus/rpc-schema";
import { createAuditChain, hashLine, ACTIVE_NAME, ANCHOR_NAME, REANCHORED_ACTION, type AuditChain } from "../../src/audit/chain.ts";
import type { AuditEvent } from "../../src/rbac/audit.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ev = (i: number): AuditEvent => ({ at: 1000 + i, actor: { user: "u", host: "h" }, action: "test.event", target: `t${i}`, detail: { i } });
const read = (dir: string, name: string): string[] => readFileSync(path.join(dir, name), "utf8").split("\n").filter((l) => l !== "");
const write = (dir: string, name: string, l: string[]): void => writeFileSync(path.join(dir, name), l.map((x) => `${x}\n`).join(""));
const reanchorEvent = (suffix: string): AuditEvent => ({
  at: 9000, actor: { user: "owner", host: "h" }, action: REANCHORED_ACTION, target: "audit-chain",
  detail: { reason: "anchor lost in a disk failure", asideSuffix: suffix, previousAnchor: { status: "missing" } },
});

/** What the Rust command does: every chain file and the anchor get the suffix, then the new chain starts with the event. */
function reanchored(o: { suffix?: string; rotated?: boolean; tamper?: (dir: string, active: string[]) => void; announce?: boolean } = {}): { dir: string; chain: AuditChain; suffix: string } {
  const suffix = o.suffix ?? "pre-reanchor-1760000000000";
  const dir = tempDir("audit-era-");
  const old = createAuditChain({ dir });
  for (let i = 0; i < 3; i++) old.append(ev(i));
  if (o.rotated) { old.rotate(); old.append(ev(3)); }
  o.tamper?.(dir, read(dir, ACTIVE_NAME));
  for (const n of readdirSync(dir)) if (/^audit-chain\.(\d{10}\.jsonl|jsonl|anchor)$/.test(n)) renameSync(path.join(dir, n), path.join(dir, `${n}.${suffix}`));
  const chain = createAuditChain({ dir });
  chain.append(o.announce === false ? ev(50) : reanchorEvent(suffix));
  return { dir, chain, suffix };
}

describe("audit.verify across a reanchor", () => {
  it("reports the reanchor event as an era boundary, not as a finding; the new chain verifies normally", () => {
    const { chain, suffix } = reanchored({ tamper: (dir) => { const f = read(dir, ACTIVE_NAME); f.splice(1, 1); write(dir, ACTIVE_NAME, f); } });
    chain.append(ev(60));
    const v = chain.verify();
    assert.deepEqual([v.ok, v.records, v.lastSeq, v.files, v.anchor, v.findingsTotal], [true, 2, 2, 1, { status: "match", seq: 2 }, 0]);
    assert.deepEqual(v.reanchors, [{ seq: 1, file: ACTIVE_NAME, line: 1, at: 9000, suffix }]);
  });

  it("checks the old chain only up to its first deviation, and that deviation does not turn the result red", () => {
    const { chain, suffix } = reanchored({ tamper: (dir) => { const f = read(dir, ACTIVE_NAME); f[1] = (f[1] as string).replace('"i":1', '"i":99'); write(dir, ACTIVE_NAME, f); } });
    const v = chain.verify();
    assert.equal(v.ok, true);
    assert.equal(v.previousChains.length, 1);
    const p = v.previousChains[0];
    assert.deepEqual([p?.suffix, p?.announced, p?.files, p?.records, p?.lastSeq, p?.intact], [suffix, true, 1, 2, 2, false]);
    assert.deepEqual(p?.firstBreak, { code: "hash-mismatch", file: `${ACTIVE_NAME}.${suffix}`, line: 3, seq: 3 });
    assert.equal(p?.lastHash, hashLine(read(chain.dir, `${ACTIVE_NAME}.${suffix}`)[1] as string));
  });

  it("an old chain that is whole and whose anchor matches is intact", () => {
    const { chain } = reanchored();
    const p = chain.verify().previousChains[0];
    assert.deepEqual([p?.records, p?.intact, p?.firstBreak, p?.anchor], [3, true, null, { status: "match", seq: 3 }]);
  });

  it("an old chain with rotated files is walked in seq order across them", () => {
    const { chain, dir, suffix } = reanchored({ rotated: true });
    assert.ok(existsSync(path.join(dir, `audit-chain.0000000001.jsonl.${suffix}`)));
    const p = chain.verify().previousChains[0];
    assert.deepEqual([p?.files, p?.records, p?.lastSeq, p?.intact], [2, 4, 4, true]);
  });

  it("an old anchor that no longer fits the old chain is shown in the old chain's own result", () => {
    const { chain, dir, suffix } = reanchored({ tamper: (d) => { const f = read(d, ACTIVE_NAME); write(d, ACTIVE_NAME, f.slice(0, 2)); } });
    const p = chain.verify().previousChains[0];
    assert.deepEqual([p?.anchor, p?.intact, p?.firstBreak], [{ status: "ahead", seq: 3 }, false, null]);
    assert.equal(chain.verify().ok, true);
    assert.ok(existsSync(path.join(dir, `${ANCHOR_NAME}.${suffix}`)));
  });

  it("a set-aside chain no event names is reported as not announced", () => {
    const { chain } = reanchored({ announce: false });
    const v = chain.verify();
    assert.deepEqual([v.ok, v.reanchors, v.previousChains.map((p) => p.announced)], [true, [], [false]]);
  });

  it("two reanchors are two eras, oldest first", () => {
    const first = reanchored({ suffix: "pre-reanchor-1760000000000" });
    const dir = first.dir;
    for (const n of readdirSync(dir)) if (/^audit-chain\.(jsonl|anchor)$/.test(n)) renameSync(path.join(dir, n), path.join(dir, `${n}.pre-reanchor-1770000000000`));
    const chain = createAuditChain({ dir });
    chain.append(reanchorEvent("pre-reanchor-1770000000000"));
    const v = chain.verify();
    assert.deepEqual(v.previousChains.map((p) => [p.suffix, p.announced, p.records]), [["pre-reanchor-1760000000000", false, 3], ["pre-reanchor-1770000000000", true, 1]]);
    assert.equal(v.ok, true);
  });

  it("damage to the NEW chain is still a finding", () => {
    const { chain, dir } = reanchored();
    chain.append(ev(1)); chain.append(ev(2));
    const f = read(dir, ACTIVE_NAME); f[1] = (f[1] as string).replace('"i":1', '"i":99'); write(dir, ACTIVE_NAME, f);
    const v = chain.verify();
    assert.equal(v.ok, false);
    assert.deepEqual(v.findings.map((x) => x.code), ["hash-mismatch"]);
    assert.equal(v.reanchors.length, 1);
  });

  it("names that merely look like set-aside files, and torn-tail evidence, are not eras", () => {
    const { chain, dir } = reanchored();
    for (const n of ["audit-chain.jsonl.pre-reanchor-abc", "audit-chain.jsonl.pre-reanchor-", "audit-chain.jsonl.torn-1", "audit-chain.0001.jsonl.pre-reanchor-5", "x-audit-chain.jsonl.pre-reanchor-5"]) writeFileSync(path.join(dir, n), "garbage\n");
    assert.deepEqual(chain.verify().previousChains.map((p) => p.suffix), ["pre-reanchor-1760000000000"]);
  });

  it("the reason and other record content of the event never reach the verify result", () => {
    const { chain } = reanchored();
    assert.ok(!JSON.stringify(chain.verify()).includes("disk failure"));
  });

  it("a reanchor event whose suffix is not a plain file suffix is shown without one", () => {
    const dir = tempDir("audit-era-bad-"); const chain = createAuditChain({ dir });
    chain.append(reanchorEvent("../../etc/passwd"));
    assert.deepEqual(chain.verify().reanchors.map((r) => [r.seq, r.suffix]), [[1, null]]);
  });

  it("the result, with eras and without, satisfies the audit.verify result schema", () => {
    const withEras = reanchored({ rotated: true, tamper: (dir) => { const f = read(dir, ACTIVE_NAME); f[0] = (f[0] as string).replace('"i":0', '"i":7'); write(dir, ACTIVE_NAME, f); } }).chain.verify();
    assert.equal(withEras.previousChains.length, 1);
    const plain = createAuditChain({ dir: tempDir("audit-era-plain-") }).verify();
    for (const r of [withEras, plain]) assert.equal(validateResult("audit.verify", r).ok, true, JSON.stringify(validateResult("audit.verify", r)));
  });
});
