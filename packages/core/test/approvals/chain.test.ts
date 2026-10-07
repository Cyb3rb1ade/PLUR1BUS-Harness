import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GENESIS_MAC } from "../../src/approvals/chain.ts";
import { KEY, OTHER_KEY, dbFile, openChain, raw } from "./helpers.ts";

const T = { timeout: 15_000 };

function seeded(n = 5) {
  const path = dbFile();
  const c = openChain(path);
  for (let i = 1; i <= n; i++) c.chain.append("note", `r${i}`, { i });
  return { path, ...c };
}

describe("approval chain: HMAC-SHA256 linkage (D109 §6)", () => {
  it("an empty chain verifies", T, () => {
    const { chain } = openChain(dbFile());
    assert.deepEqual(chain.verify(), { ok: true, entries: 0, head: null });
  });

  it("every entry carries the HMAC of its predecessor; the first carries the genesis value", T, () => {
    const { chain } = seeded(3);
    const e = chain.snapshot().entries;
    assert.equal(e[0]!.prevMac, GENESIS_MAC);
    assert.equal(e[1]!.prevMac, e[0]!.mac);
    assert.equal(e[2]!.prevMac, e[1]!.mac);
    assert.match(e[0]!.mac, /^[0-9a-f]{64}$/);
    const v = chain.verify();
    assert.ok(v.ok);
    assert.deepEqual(v.ok && v.head, { seq: 3, mac: e[2]!.mac });
  });

  it("modification is detected at the modified position", T, () => {
    const { path, chain } = seeded();
    const r = raw(path);
    r.prepare("UPDATE approval_chain SET payload = '{\"i\":99}' WHERE seq = 3").run();
    const v = chain.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [3, "mac-mismatch"]);
    r.close();
  });

  it("deleting a middle entry is detected at the missing position", T, () => {
    const { path, chain } = seeded();
    const r = raw(path);
    r.prepare("DELETE FROM approval_chain WHERE seq = 3").run();
    const v = chain.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [3, "seq-gap"]);
    r.close();
  });

  it("deleting the tail is detected through the keyed head", T, () => {
    const { path, chain } = seeded();
    const r = raw(path);
    r.prepare("DELETE FROM approval_chain WHERE seq >= 4").run();
    const v = chain.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [4, "truncated"]);
    r.close();
  });

  it("a tail cut with a re-pointed head is still detected (the head tag is keyed)", T, () => {
    const { path, chain } = seeded();
    const r = raw(path);
    r.prepare("DELETE FROM approval_chain WHERE seq >= 4").run();
    const last = r.prepare("SELECT seq, mac FROM approval_chain WHERE seq = 3").get() as { seq: number; mac: string };
    r.prepare("UPDATE chain_head SET seq = ?, mac = ?").run(last.seq, last.mac);
    const v = chain.verify();
    assert.ok(!v.ok);
    assert.equal(v.reason, "head-mismatch");
    r.close();
  });

  it("reordering is detected at the first displaced position", T, () => {
    const { path, chain } = seeded();
    const r = raw(path);
    r.exec("UPDATE approval_chain SET seq = 100 WHERE seq = 2; UPDATE approval_chain SET seq = 2 WHERE seq = 3; UPDATE approval_chain SET seq = 3 WHERE seq = 100");
    const v = chain.verify();
    assert.ok(!v.ok);
    assert.equal(v.brokenAt, 2);
    r.close();
  });

  it("replaying a copy of an earlier entry at the end is detected at that position", T, () => {
    const { path, chain } = seeded();
    const r = raw(path);
    r.exec("INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) SELECT 6, ts, kind, ref_id, nonce, payload, prev_mac, mac FROM approval_chain WHERE seq = 2");
    const v = chain.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [6, "prev-mismatch"]);
    r.close();
  });

  it("a different key breaks the chain at position 1 (fail closed)", T, () => {
    const { path } = seeded();
    const { chain } = openChain(path, { key: OTHER_KEY });
    const v = chain.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [1, "mac-mismatch"]);
  });

  it("verify sees tampering done by another connection after an earlier clean verify", T, () => {
    const { path, chain } = seeded();
    assert.ok(chain.verify().ok);
    const r = raw(path);
    r.prepare("UPDATE approval_chain SET kind = 'x' WHERE seq = 5").run();
    r.close();
    const v = chain.verify();
    assert.ok(!v.ok);
    assert.equal(v.brokenAt, 5);
  });

  it("append refuses to extend a broken chain", T, () => {
    const { path, chain } = seeded();
    const r = raw(path);
    r.prepare("UPDATE approval_chain SET payload = '{}' WHERE seq = 2").run();
    r.close();
    assert.throws(() => chain.append("note", "r9", {}), /chain is broken at 2/);
  });

  it("key length is checked", T, () => {
    assert.throws(() => openChain(dbFile(), { key: Buffer.alloc(8) }), /at least 32 bytes/);
    assert.ok(KEY.length >= 32);
  });
});
