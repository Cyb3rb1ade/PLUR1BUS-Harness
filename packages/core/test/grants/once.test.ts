import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { MIN, alwaysCap, call, ctx, dbFile, decideWith, open } from "./helpers.ts";
import { KEY } from "./helpers.ts";

const T = { timeout: 30_000 };
const OUT = { outsideRoots: true };
const who = { person: "christian", agent: "bernd", actionHash: "h1" };
const onceGrant = (s: Awaited<ReturnType<typeof open>>, o: object = {}) => s.grants.create(alwaysCap({
  capability: "fs.write", scope: "once", match: { kind: "action" }, actionHash: "h1", id: "once1", ...o,
}));
const outWrite = () => call({ capability: "fs.write", tool: "fs.write", access: "write", targets: ["/data/x"], flags: OUT, actionHash: "h1" });

describe("once grants: atomic consumption (D109 §4/§6)", () => {
  it("decide allows via the grant, consumeOnce spends it, the same call then asks again", T, async () => {
    const s = await open();
    onceGrant(s);
    assert.deepEqual(decideWith(s, outWrite(), ctx()), { kind: "allow", via: "grant", grantId: "once1" });
    assert.equal(s.grants.consumeOnce("once1", who), true);
    assert.equal(decideWith(s, outWrite(), ctx()).kind, "ask");
    assert.equal(s.grants.consumeOnce("once1", who), false);
    assert.equal(s.grants.list({ person: "christian", agent: "bernd", capability: "fs.write" }).length, 0);
    assert.ok(s.grants.get("once1")!.consumedAt !== undefined);
  });

  it("a grant for another action hash never applies and cannot be consumed with another hash", T, async () => {
    const s = await open();
    onceGrant(s);
    assert.equal(decideWith(s, call({ ...outWrite(), actionHash: "h2" }), ctx()).kind, "ask");
    assert.equal(s.grants.consumeOnce("once1", { ...who, actionHash: "h2" }), false);
    assert.equal(s.grants.consumeOnce("once1", { ...who, agent: "other" }), false);
    assert.equal(s.grants.consumeOnce("once1", { ...who, person: "mallory" }), false);
    assert.equal(s.grants.consumeOnce("once1", who), true);
  });

  it("ends after 10 minutes unused", T, async () => {
    const s = await open();
    onceGrant(s);
    s.clock.advance(10 * MIN);
    assert.equal(decideWith(s, outWrite(), ctx()).kind, "ask");
    assert.equal(s.grants.consumeOnce("once1", who), false);
  });

  it("a revoked once grant cannot be consumed", T, async () => {
    const s = await open();
    onceGrant(s);
    s.grants.revoke("once1", "christian");
    assert.equal(s.grants.consumeOnce("once1", who), false);
  });

  it("two parallel calls on one connection: exactly one wins", T, async () => {
    const s = await open();
    onceGrant(s);
    const r = await Promise.all([0, 1].map(async () => s.grants.consumeOnce("once1", who)));
    assert.deepEqual(r.filter(Boolean).length, 1);
  });

  it("two stores on one file, started together: exactly one wins", T, async () => {
    const path = dbFile();
    const a = await open(path);
    const b = await open(path, { clock: a.clock });
    onceGrant(a);
    const r = await Promise.all([Promise.resolve().then(() => a.grants.consumeOnce("once1", who)), Promise.resolve().then(() => b.grants.consumeOnce("once1", who))]);
    assert.equal(r.filter(Boolean).length, 1);
  });

  it("eight worker threads racing on one file: exactly one wins and the chain stays valid", T, async () => {
    const path = dbFile();
    const s = await open(path);
    onceGrant(s);
    const sab = new SharedArrayBuffer(4);
    const gate = new Int32Array(sab);
    const url = new URL("./once-worker.ts", import.meta.url);
    const workers = Array.from({ length: 8 }, () => new Promise<boolean>((resolve, reject) => {
      const w = new Worker(url, { workerData: { path, key: Buffer.from(KEY).toString("hex"), now: s.clock.now(), gate: sab } });
      w.once("message", (m: { won: boolean }) => resolve(m.won));
      w.once("error", reject);
    }));
    await new Promise((r) => setTimeout(r, 400)); // let every worker open the database and park on the gate
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const won = (await Promise.all(workers)).filter(Boolean).length;
    assert.equal(won, 1);
    assert.ok(s.chain.verify().ok);
    assert.equal(s.grants.consumeOnce("once1", who), false);
  });
});
