// b06 audit: expiry boundary, resurrection, input hygiene, agent isolation, persistence, scope matching through decide().
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GrantError } from "../../src/grants/store.ts";
import { DAY, HOUR, MIN, alwaysCap, call, ctx, dbFile, decideWith, open } from "./helpers.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 15_000 };
const OUT = { outsideRoots: true };
const refused = (e: unknown) => e instanceof GrantError && e.code === "invalid-grant";
const pathGrant = (p: string, o: object = {}) => alwaysCap({ match: { kind: "path", path: p, access: "read", recursive: true }, ...o });
const outRead = (p = "/data/x") => call({ targets: [abs(p)], flags: OUT });

describe("grants audit: expiry", () => {
  it("markUsed does not resurrect an always grant that already lapsed (90 days unused)", T, async () => {
    const s = await open();
    const g = s.grants.create(pathGrant(abs("/data")));
    s.clock.advance(91 * DAY);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
    s.grants.markUsed(g.id);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
    assert.equal(s.grants.get(g.id)!.lastUsedAt, undefined);
  });

  it("markUsed does not resurrect a session grant idle for 7 days", T, async () => {
    const s = await open();
    const g = s.grants.create(pathGrant(abs("/data"), { scope: "session", sessionId: "s1" }));
    s.clock.advance(7 * DAY);
    s.grants.markUsed(g.id);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
  });

  it("markUsed does not extend a grant past its own expiresAt", T, async () => {
    const s = await open();
    const g = s.grants.create(pathGrant(abs("/data"), { expiresAt: s.clock.now() + HOUR }));
    s.clock.advance(HOUR);
    s.grants.markUsed(g.id);
    assert.equal(s.grants.get(g.id)!.lastUsedAt, undefined);
  });

  it("the boundary is exact: allowed 1 ms before expiresAt, asked at expiresAt", T, async () => {
    const s = await open();
    s.grants.create(pathGrant(abs("/data"), { expiresAt: s.clock.now() + HOUR }));
    s.clock.advance(HOUR - 1);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow");
    s.clock.advance(1);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
  });

  it("the 90 day boundary is exact and a recorded use moves it", T, async () => {
    const s = await open();
    const g = s.grants.create(pathGrant(abs("/data")));
    s.clock.advance(90 * DAY - 1);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow");
    s.grants.markUsed(g.id);
    s.clock.advance(90 * DAY - 1);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow");
    s.clock.advance(1);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
  });

  it("a grant created with an expiry that is not in the future is refused", T, async () => {
    const s = await open();
    assert.throws(() => s.grants.create(pathGrant(abs("/data"), { expiresAt: s.clock.now() })), refused);
    assert.throws(() => s.grants.create(pathGrant(abs("/data"), { expiresAt: s.clock.now() - 1 })), refused);
    assert.throws(() => s.grants.create(pathGrant(abs("/data"), { expiresAt: -1 })), refused);
    assert.doesNotThrow(() => s.grants.create(pathGrant(abs("/data"), { expiresAt: s.clock.now() + 1 })));
  });

  it("a once grant is consumable until, but not at, its 10 minute / expiresAt limit", T, async () => {
    const s = await open();
    const mk = (id: string, o: object = {}) => s.grants.create({ ...alwaysCap({ scope: "once", match: { kind: "action" }, actionHash: "h1", id }), ...o });
    const b = { person: "christian", agent: "bernd", actionHash: "h1" };
    mk("o1"); mk("o2"); mk("o3", { expiresAt: s.clock.now() + 5 * MIN });
    s.clock.advance(5 * MIN - 1);
    assert.equal(s.grants.consumeOnce("o3", b), true);
    s.clock.advance(1);
    assert.equal(s.grants.consumeOnce("o2", b), true);
    mk("o4");
    s.clock.advance(10 * MIN);
    assert.equal(s.grants.consumeOnce("o4", b), false);
    assert.equal(s.grants.consumeOnce("o1", b), false);
  });
});

describe("grants audit: input hygiene", () => {
  it("refuses a path that is not canonical instead of storing a grant that can never match", T, async () => {
    const s = await open();
    for (const p of ["/", "//", "/data/", "/data//x", "/data/./x"]) {
      assert.throws(() => s.grants.create(pathGrant(p)), refused, p);
    }
  });

  it("refuses identifiers of absurd length", T, async () => {
    const s = await open();
    const big = "x".repeat(10_000);
    assert.throws(() => s.grants.create(alwaysCap({ person: big })), refused);
    assert.throws(() => s.grants.create(alwaysCap({ agent: big })), refused);
    assert.throws(() => s.grants.create(alwaysCap({ createdBy: big })), refused);
    assert.throws(() => s.grants.create(alwaysCap({ id: big })), refused);
    assert.throws(() => s.grants.create(alwaysCap({ scope: "task", taskId: big })), refused);
    assert.throws(() => s.grants.create(alwaysCap({ projectId: big })), refused);
    assert.throws(() => s.grants.create(alwaysCap({ effect: big })), refused);
  });
});

describe("grants audit: scope matching through decide()", () => {
  it("wildcard characters and dot-names in a grant path are literal, never patterns", T, async () => {
    const s = await open();
    if (process.platform === "win32") {
      // No Windows name holds `*` or `?`, so there such a grant path names nothing and is refused when it is created: stricter
      // than a literal match, and never a pattern either.
      for (const p of ["/data/*", "/data/a?"]) assert.throws(() => s.grants.create(pathGrant(abs(p))), (e) => refused(e) && /forbidden-char/.test((e as Error).message), p);
      assert.equal(decideWith(s, outRead("/data/x"), ctx()).kind, "ask");
      assert.equal(decideWith(s, outRead("/data/ab/x"), ctx()).kind, "ask");
    } else {
      s.grants.create(pathGrant(abs("/data/*")));
      s.grants.create(pathGrant(abs("/data/a?")));
      assert.equal(decideWith(s, outRead("/data/x"), ctx()).kind, "ask");
      assert.equal(decideWith(s, outRead("/data/ab/x"), ctx()).kind, "ask");
      assert.equal(decideWith(s, outRead("/data/*/x"), ctx()).kind, "allow"); // the literal directory named "*"
    }
  });

  it("a sibling that merely shares the prefix, and a parent, are not covered; case differs", T, async () => {
    const s = await open();
    s.grants.create(pathGrant(abs("/data/proj")));
    for (const p of ["/data/project/x", "/data/proj-x", "/data", "/data/PROJ/x", "/data/proj2"]) {
      assert.equal(decideWith(s, outRead(p), ctx()).kind, "ask", p);
    }
    assert.equal(decideWith(s, outRead("/data/proj/a/b"), ctx()).kind, "allow");
  });

  it("a non-recursive grant covers direct children only; a traversal target is never covered", T, async () => {
    const s = await open();
    s.grants.create(alwaysCap({ match: { kind: "path", path: abs("/data"), access: "read", recursive: false } }));
    assert.equal(decideWith(s, outRead("/data/x"), ctx()).kind, "allow");
    assert.equal(decideWith(s, outRead("/data/x/y"), ctx()).kind, "ask");
    assert.equal(decideWith(s, outRead("/data/../etc/passwd"), ctx()).kind, "ask");
    assert.equal(decideWith(s, outRead("/data/./x"), ctx()).kind, "ask");
  });

  it("one uncovered target among several denies the lot", T, async () => {
    const s = await open();
    s.grants.create(pathGrant(abs("/data")));
    const c = call({ targets: [abs("/data/a"), abs("/etc/b")], flags: OUT });
    assert.equal(decideWith(s, c, ctx()).kind, "ask");
  });
});

describe("grants audit: agent / person isolation, revocation, persistence", () => {
  it("a grant for agent bernd does not serve another agent or another person", T, async () => {
    const s = await open();
    const g = s.grants.create(pathGrant(abs("/data")));
    assert.deepEqual(decideWith(s, outRead(), ctx()), { kind: "allow", via: "grant", grantId: g.id });
    assert.equal(decideWith(s, outRead(), ctx({ subject: { kind: "agent", agentId: "other" } })).kind, "ask");
    assert.equal(decideWith(s, outRead(), ctx({ principal: { person: "anna" } })).kind, "ask");
    assert.equal(decideWith(s, outRead(), ctx({ subject: { kind: "agent", agentId: "BERND" } })).kind, "ask");
  });

  it("a sub-agent cannot use another agent's non-delegable grant even when it names the id", T, async () => {
    const s = await open();
    const g = s.grants.create(pathGrant(abs("/data"), { scope: "task", taskId: "t1" }));
    const sub = ctx({ subject: { kind: "subagent", agentId: "helper" }, handoff: { scope: ["fs.read"], taskId: "t1", approvalsHeld: [g.id] } });
    assert.equal(decideWith(s, outRead(), sub).kind, "ask");
  });

  it("a revoked or expired delegable grant no longer serves a sub-agent", T, async () => {
    const s = await open();
    const mk = (id: string) => s.grants.create(pathGrant(abs("/data"), { id, scope: "task", taskId: "t1", delegable: true }));
    const sub = (id: string) => ctx({ subject: { kind: "subagent", agentId: "helper" }, handoff: { scope: ["fs.read"], taskId: "t1", approvalsHeld: [id] } });
    mk("d1"); mk("d2");
    assert.equal(decideWith(s, outRead(), sub("d1")).kind, "allow");
    s.grants.revoke("d1", "christian");
    assert.equal(decideWith(s, outRead(), sub("d1")).kind, "ask");
    s.clock.advance(24 * HOUR);
    assert.equal(decideWith(s, outRead(), sub("d2")).kind, "ask");
  });

  it("revocation, task end and consumption survive a restart; an expired grant stays expired", T, async () => {
    const path = dbFile();
    const a = await open(path);
    a.grants.create(pathGrant(abs("/data"), { id: "keep" }));
    a.grants.create(pathGrant(abs("/data"), { id: "gone" }));
    a.grants.create(pathGrant(abs("/data"), { id: "tsk", scope: "task", taskId: "t9" }));
    a.grants.create({ ...alwaysCap({ scope: "once", match: { kind: "action" }, actionHash: "h1", id: "once1" }) });
    a.grants.revoke("gone", "christian");
    a.grants.endTask("t9");
    assert.equal(a.grants.consumeOnce("once1", { person: "christian", agent: "bernd", actionHash: "h1" }), true);
    a.close();
    const b = await open(path, { clock: a.clock });
    assert.deepEqual(b.grants.list({ person: "christian", agent: "bernd", capability: "fs.read" }).map((g) => g.id), ["keep"]);
    assert.equal(b.grants.consumeOnce("once1", { person: "christian", agent: "bernd", actionHash: "h1" }), false);
    assert.equal(b.grants.revoke("gone", "christian"), false);
    assert.equal(decideWith(b, outRead(), ctx()).kind, "allow");
    b.clock.advance(91 * DAY);
    b.close();
    const c = await open(path, { clock: a.clock });
    assert.equal(decideWith(c, outRead(), ctx()).kind, "ask");
    c.grants.markUsed("keep");
    c.close();
    const d = await open(path, { clock: a.clock });
    assert.equal(decideWith(d, outRead(), ctx()).kind, "ask");
    d.close();
  });

  it("endTask only ends task grants of that task, never always or session grants with the same id string", T, async () => {
    const s = await open();
    s.grants.create(pathGrant(abs("/data"), { id: "al", taskId: "t1" }));
    s.grants.create(pathGrant(abs("/data"), { id: "se", scope: "session", sessionId: "t1" }));
    assert.equal(s.grants.endTask("t1"), 0);
    assert.equal(s.grants.endSession("t1"), 1);
    assert.equal(s.grants.get("al")!.revoked, undefined);
  });
});
