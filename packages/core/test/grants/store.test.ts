import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GrantError } from "../../src/grants/store.ts";
import { DAY, HOUR, MIN, alwaysCap, call, ctx, dbFile, decideWith, open, raw } from "./helpers.ts";

const T = { timeout: 15_000 };
const code = (c: string) => (e: unknown) => { assert.ok(e instanceof GrantError, String(e)); assert.equal(e.code, c); return true; };
const OUT = { outsideRoots: true };

describe("grant store: model and validation", () => {
  it("round-trips every field and survives reopening the file", T, async () => {
    const path = dbFile();
    const a = await open(path);
    const g = a.grants.create({
      capability: "fs.write", person: "christian", agent: "bernd", scope: "always", createdBy: "christian@cli", surface: 3, effect: "local-write",
      match: { kind: "path", path: "/data/in", access: "write", recursive: true }, expiresAt: a.clock.now() + 400 * DAY, projectId: "p1", delegable: true,
    });
    a.close();
    const b = await open(path, { clock: a.clock });
    const got = b.grants.get(g.id)!;
    assert.deepEqual(got, g);
    assert.deepEqual(
      [got.capability, got.person, got.agent, got.scope, got.createdAt, got.surface, got.projectId, got.delegable],
      ["fs.write", "christian", "bernd", "always", a.clock.now(), 3, "p1", true],
    );
    assert.equal((got as { createdBy: string }).createdBy, "christian@cli");
    assert.equal(b.grants.list({ person: "christian", agent: "bernd", capability: "fs.write" }).length, 1);
    b.close();
  });

  it("list filters by person, agent and capability", T, async () => {
    const s = await open();
    s.grants.create(alwaysCap());
    s.grants.create(alwaysCap({ agent: "other" }));
    s.grants.create(alwaysCap({ person: "anna" }));
    s.grants.create(alwaysCap({ capability: "clipboard.read", scope: "session", sessionId: "s1" }));
    assert.equal(s.grants.list({ person: "christian", agent: "bernd", capability: "fs.read" }).length, 1);
    assert.equal(s.grants.list({ person: "christian", agent: "bernd", capability: "clipboard.read" }).length, 1);
    assert.equal(s.grants.list({ person: "christian", agent: "nobody", capability: "fs.read" }).length, 0);
  });

  it("refuses what the taxonomy forbids", T, async () => {
    const s = await open();
    assert.throws(() => s.grants.create(alwaysCap({ capability: "nope.nope" })), code("invalid-grant"));
    assert.throws(() => s.grants.create(alwaysCap({ capability: "harness.admin" })), code("never-capability"));
    assert.throws(() => s.grants.create(alwaysCap({ capability: "sys.read" })), code("ceiling-exceeded"));
    assert.throws(() => s.grants.create(alwaysCap({ capability: "pkg.change" })), code("ceiling-exceeded")); // once only
    assert.throws(() => s.grants.create(alwaysCap({ capability: "fs.delete" })), code("ceiling-exceeded")); // task at most
    assert.throws(() => s.grants.create(alwaysCap({ surface: 0 })), code("surface-too-low"));
    assert.throws(() => s.grants.create(alwaysCap({ capability: "shell.exec", surface: 1 })), code("surface-too-low"));
  });

  it("refuses inconsistent bindings", T, async () => {
    const s = await open();
    assert.throws(() => s.grants.create(alwaysCap({ scope: "once" })), code("invalid-grant"));
    assert.throws(() => s.grants.create(alwaysCap({ scope: "task" })), code("invalid-grant"));
    assert.throws(() => s.grants.create(alwaysCap({ scope: "session" })), code("invalid-grant"));
    assert.throws(() => s.grants.create(alwaysCap({ match: { kind: "action" } })), code("invalid-grant"));
    assert.throws(() => s.grants.create(alwaysCap({ scope: "session", sessionId: "s", jobId: "j" })), code("invalid-grant"));
    assert.throws(() => s.grants.create(alwaysCap({ match: { kind: "path", path: "relative/x", access: "read", recursive: true } })), code("invalid-grant"));
    assert.throws(() => s.grants.create(alwaysCap({ match: { kind: "path", path: "/a/../etc", access: "read", recursive: true } })), code("invalid-grant"));
    s.grants.create(alwaysCap({ id: "dup" }));
    assert.throws(() => s.grants.create(alwaysCap({ id: "dup" })), code("duplicate-id"));
  });
});

describe("grant resolution: lifetimes, revocation (D109 §4)", () => {
  const grantFor = (s: Awaited<ReturnType<typeof open>>, cap = "fs.read") => s.grants.create({
    capability: cap, person: "christian", agent: "bernd", scope: "always", match: { kind: "path", path: "/data", access: "read", recursive: true }, createdBy: "christian", surface: 3,
  });
  const outRead = () => call({ targets: ["/data/x"], flags: OUT });

  it("outside the roots and without a grant it is approval; a path grant allows exactly its subtree", T, async () => {
    const s = await open();
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
    const g = grantFor(s);
    assert.deepEqual(decideWith(s, outRead(), ctx()), { kind: "allow", via: "grant", grantId: g.id });
    assert.equal(decideWith(s, call({ targets: ["/data2/x"], flags: OUT }), ctx()).kind, "ask");
    assert.equal(decideWith(s, call({ targets: ["/data/x"], flags: OUT, capability: "fs.write", tool: "fs.write", access: "write" }), ctx()).kind, "ask");
  });

  it("task grants end with the task, session grants with the session, others are untouched", T, async () => {
    const s = await open();
    const mk = (scope: "task" | "session", id: string, o: object) => s.grants.create(alwaysCap({ scope, match: { kind: "path", path: "/data", access: "read", recursive: true }, ...o, id }));
    mk("task", "t1g", { taskId: "t1" });
    mk("task", "t2g", { taskId: "t2" });
    mk("session", "s1g", { sessionId: "s1" });
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow");
    assert.equal(s.grants.endTask("t1"), 1);
    assert.equal(s.grants.get("t1g")!.revoked, true);
    assert.equal(s.grants.get("t2g")!.revoked, undefined);
    // the session grant still carries the call
    assert.deepEqual(decideWith(s, outRead(), ctx()), { kind: "allow", via: "grant", grantId: "s1g" });
    assert.equal(s.grants.endSession("s1"), 1);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
    assert.equal((s.grants.get("t1g") as { endReason?: string }).endReason, "task-ended");
    assert.equal(s.grants.endTask("t1"), 0);
  });

  it("task and session grants are also bounded by 24 h and 7 days idle", T, async () => {
    const s = await open();
    s.grants.create(alwaysCap({ scope: "task", taskId: "t1", match: { kind: "path", path: "/data", access: "read", recursive: true } }));
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow");
    s.clock.advance(24 * HOUR);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
  });

  it("always lasts until revoked and expires after 90 days unused", T, async () => {
    const s = await open();
    const g = grantFor(s);
    s.clock.advance(89 * DAY);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow");
    s.clock.advance(2 * DAY);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
    assert.ok(s.grants.get(g.id)); // still listed, just not applicable
  });

  it("a recorded use restarts the 90 days (taken from the chain, not the row)", T, async () => {
    const s = await open();
    const g = grantFor(s);
    s.clock.advance(60 * DAY);
    s.grants.markUsed(g.id);
    s.clock.advance(60 * DAY);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow");
    assert.equal(s.grants.get(g.id)!.lastUsedAt, s.clock.now() - 60 * DAY);
    // a row edited to claim a recent use changes nothing
    const r = raw(s.path);
    r.prepare("UPDATE grants SET last_used_at = ?").run(s.clock.now());
    r.close();
    s.clock.advance(31 * DAY);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
  });

  it("markUsed records at most once per hour (the chain stays small)", T, async () => {
    const s = await open();
    const g = grantFor(s);
    const before = s.chain.verify().entries;
    for (let i = 0; i < 5; i++) { s.grants.markUsed(g.id); s.clock.advance(MIN); }
    assert.equal(s.chain.verify().entries, before + 1);
    s.clock.advance(HOUR);
    s.grants.markUsed(g.id);
    assert.equal(s.chain.verify().entries, before + 2);
  });

  it("revocation is immediate and idempotent, and reverts the call to asking", T, async () => {
    const s = await open();
    const g = grantFor(s);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow");
    assert.equal(s.grants.revoke(g.id, "christian"), true);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
    assert.equal(s.grants.list({ person: "christian", agent: "bernd", capability: "fs.read" }).length, 0);
    assert.equal(s.grants.revoke(g.id, "christian"), false);
    assert.equal(s.grants.revoke("unknown", "christian"), false);
  });

  it("a revocation made on another connection is seen at once", T, async () => {
    const path = dbFile();
    const a = await open(path);
    const b = await open(path, { clock: a.clock });
    const g = grantFor(a);
    assert.equal(decideWith(b, outRead(), ctx()).kind, "allow");
    a.grants.revoke(g.id, "christian");
    assert.equal(decideWith(b, outRead(), ctx()).kind, "ask");
  });

  it("a job grant serves only its job; session and task grants never serve a headless run", T, async () => {
    const s = await open();
    s.grants.create(alwaysCap({ jobId: "job1", match: { kind: "path", path: "/data", access: "read", recursive: true } }));
    s.grants.create(alwaysCap({ scope: "session", sessionId: "s1", id: "sess", match: { kind: "path", path: "/data", access: "read", recursive: true } }));
    assert.equal(decideWith(s, outRead(), ctx({ headless: { jobId: "job1" } })).kind, "allow");
    const other = decideWith(s, outRead(), ctx({ headless: { jobId: "job2" } }));
    assert.deepEqual([other.kind, other.kind === "ask" && other.park], ["ask", true]);
    assert.equal(decideWith(s, outRead(), ctx()).kind, "allow"); // the session grant for the interactive run
    s.grants.revoke("sess", "christian");
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask"); // the job grant does not leak into sessions
  });

  it("a delegable grant can be referenced by a sub-agent; a forged id cannot", T, async () => {
    const s = await open();
    const g = s.grants.create(alwaysCap({ scope: "task", taskId: "t1", delegable: true, match: { kind: "path", path: "/data", access: "read", recursive: true } }));
    const sub = (held: string[]) => ctx({
      subject: { kind: "subagent", agentId: "helper" },
      handoff: { scope: ["fs.read"], taskId: "t1", approvalsHeld: held },
    });
    assert.deepEqual(decideWith(s, outRead(), sub([g.id])), { kind: "allow", via: "grant", grantId: g.id });
    assert.equal(decideWith(s, outRead(), sub(["grt_forged"])).kind, "ask");
    assert.equal(decideWith(s, outRead(), sub([])).kind, "ask");
  });
});
