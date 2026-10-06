import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES, DEFAULTS, EFFECTS, NEVER_CAPABILITIES, decide, fromExtensionEffect, fromMcp, fromSideEffects, grantExpiry, grantReviewDue,
  maxScopeFor, pathCovered, requiredSurface, riskOf, surfaceMayDecide, type ApprovalRequest, type Decision,
} from "../../src/policy/index.ts";
import { DAY, FakeClock, HOUR, MIN, MemoryGrants, NOW, call, ctx, flags, grant, run } from "./helpers.ts";

const T = { timeout: 10_000 };
const OUT = { outsideRoots: true };
const pathGrant = (scope: "task" | "session" | "always" = "always") => grant("fs.read", scope, { kind: "path", path: "/data", access: "read", recursive: true });
const outRead = () => call({ targets: ["/data/x"], flags: OUT });

describe("precedence: deny-list > never > tools.deny > grants > roots", () => {
  const everything = () => ({
    c: call({ capability: "harness.admin", flags: { denyListHit: true } }),
    x: ctx({ toolsDeny: ["harness.admin"] }),
  });
  it("deny-list beats never", T, () => {
    const { c, x } = everything();
    assert.deepEqual(run(c, x), { kind: "deny", reason: "deny-list", rule: "deny-list" });
  });
  it("never beats tools.deny", T, () => {
    const { c, x } = everything();
    c.flags.denyListHit = false;
    assert.deepEqual(run(c, x), { kind: "deny", reason: "policy-never", rule: "never" });
  });
  it("tools.deny beats a valid grant", T, () => {
    const d = run(outRead(), ctx({ toolsDeny: ["fs.read"] }), [pathGrant()]);
    assert.deepEqual(d, { kind: "deny", reason: "policy-never", rule: "tools.deny" });
  });
  it("tools.deny matches by tool name and by prefix", T, () => {
    assert.equal(run(call({ tool: "mcp.search" }), ctx({ toolsDeny: ["mcp.search"] })).kind, "deny");
    assert.equal(run(call(), ctx({ toolsDeny: ["fs.*"] })).kind, "deny");
    assert.equal(run(call(), ctx({ toolsDeny: ["shell.*"] })).kind, "allow");
  });
  it("a grant beats the default of approval outside roots", T, () => {
    assert.equal(run(outRead(), ctx()).kind, "ask");
    const d = run(outRead(), ctx(), [pathGrant()]);
    assert.equal(d.kind, "allow");
    if (d.kind === "allow") assert.equal(d.via, "grant");
  });
  it("roots beat the default: inside is allowed, outside asks", T, () => {
    assert.deepEqual(run(call(), ctx()), { kind: "allow", via: "default" });
    assert.equal(run(outRead(), ctx()).kind, "ask");
  });
  it("the deny-list also beats a grant on the same path", T, () => {
    const c = call({ targets: ["/data/.ssh/id"], flags: { ...OUT, denyListHit: true } });
    assert.equal(run(c, ctx(), [pathGrant()]).kind, "deny");
  });
});

describe("grant lifetimes with an injected clock", () => {
  const shell = () => call({ capability: "shell.exec", flags: { sandboxed: true } });
  it("always expires 90 days after its last use, not before", T, () => {
    const clock = new FakeClock();
    const g = grant("shell.exec", "always", undefined, { createdAt: NOW, surface: 3 });
    clock.advance(90 * DAY - 1);
    assert.equal(run(shell(), ctx(), [g], clock).kind, "allow");
    clock.advance(1);
    assert.equal(run(shell(), ctx(), [g], clock).kind, "ask");
  });
  it("use pushes the 90 days out", T, () => {
    const clock = new FakeClock(NOW + 100 * DAY);
    const g = grant("shell.exec", "always", undefined, { createdAt: NOW, lastUsedAt: NOW + 50 * DAY });
    assert.equal(run(shell(), ctx(), [g], clock).kind, "allow");
    clock.t = NOW + 141 * DAY;
    assert.equal(run(shell(), ctx(), [g], clock).kind, "ask");
  });
  it("an explicit expiresAt can only shorten it", T, () => {
    const g = grant("shell.exec", "always", undefined, { createdAt: NOW, expiresAt: NOW + DAY });
    assert.equal(grantExpiry(g), NOW + DAY);
    const long = grant("shell.exec", "always", undefined, { createdAt: NOW, expiresAt: NOW + 400 * DAY });
    assert.equal(grantExpiry(long), NOW + 90 * DAY);
  });
  it("once 10 min, task 24 h, session 7 days idle", T, () => {
    const o = grant("x", "once", undefined, { createdAt: NOW });
    const t = grant("x", "task", undefined, { createdAt: NOW });
    const s = grant("x", "session", undefined, { createdAt: NOW });
    assert.equal(grantExpiry(o), NOW + 10 * MIN);
    assert.equal(grantExpiry(t), NOW + 24 * HOUR);
    assert.equal(grantExpiry(s), NOW + 7 * DAY);
    assert.equal(grantExpiry({ ...s, lastUsedAt: NOW + 3 * DAY }), NOW + 10 * DAY);
  });
  it("the review nudge comes at 90 days of age", T, () => {
    const g = grant("shell.exec", "always", undefined, { createdAt: NOW, lastUsedAt: NOW + 80 * DAY });
    assert.equal(grantReviewDue(g, NOW + 89 * DAY), false);
    assert.equal(grantReviewDue(g, NOW + 90 * DAY), true);
    const clock = new FakeClock(NOW + 95 * DAY);
    const d = run(shell(), ctx(), [g], clock);
    assert.deepEqual(d, { kind: "allow", via: "grant", grantId: g.id, reviewDue: true });
  });
  it("the always default is the table's, in one place", T, () => {
    assert.equal(DEFAULTS.lifetimes.alwaysUnusedMs, 90 * DAY);
    assert.equal(DEFAULTS.reviewNudgeAgeMs, 90 * DAY);
  });
});

describe("grant ceilings and flags", () => {
  const d = (id: string) => CAPABILITIES.get(id)!;
  it("money.spend, os.privilege and pkg.change are once only", T, () => {
    for (const id of ["money.spend", "os.privilege", "pkg.change"]) assert.equal(maxScopeFor(d(id), flags()), "once");
  });
  it("fs.delete tops out at task, shell at always", T, () => {
    assert.equal(maxScopeFor(d("fs.delete"), flags()), "task");
    assert.equal(maxScopeFor(d("shell.exec"), flags()), "always");
  });
  it("a batch, a public publish and a system tree lower the ceiling", T, () => {
    assert.equal(maxScopeFor(d("shell.exec"), flags({ batch: true })), "once");
    assert.equal(maxScopeFor(d("net.publish"), flags({ publishPublic: true })), "once");
    assert.equal(maxScopeFor(d("fs.read"), flags({ systemTree: true })), "task");
  });
  it("a request offers only scopes up to the ceiling, narrowest first", T, () => {
    const r = run(call({ capability: "fs.delete" }), ctx());
    assert.equal(r.kind, "ask");
    if (r.kind === "ask") assert.deepEqual(r.request.grantOptions.map((o) => o.scope), ["once", "task"]);
  });
  it("a grant above its ceiling is ignored", T, () => {
    assert.equal(run(call({ capability: "fs.delete" }), ctx(), [grant("fs.delete", "always")]).kind, "ask");
  });
  it("a path grant needs the call's access; a capability grant does not cover outside roots", T, () => {
    assert.equal(run(call({ targets: ["/data/x"], flags: OUT, access: undefined as never }), ctx(), [pathGrant()]).kind, "ask");
    assert.equal(run(call({ capability: "fs.write", access: "write", flags: OUT }), ctx(), [grant("fs.write", "always")]).kind, "ask");
  });
  it("a grant is bound to its project", T, () => {
    const g = grant("shell.exec", "always", undefined, { projectId: "p1" });
    const c = call({ capability: "shell.exec", flags: { sandboxed: true } });
    assert.equal(run(c, ctx({ projectId: "p1" }), [g]).kind, "allow");
    assert.equal(run(c, ctx({ projectId: "p2" }), [g]).kind, "ask");
    assert.equal(run(c, ctx(), [g]).kind, "ask");
  });
});

describe("path coverage is exact-form", () => {
  it("recursive vs direct children", T, () => {
    assert.equal(pathCovered("/a/b", true, "/a/b/c/d"), true);
    assert.equal(pathCovered("/a/b", false, "/a/b/c"), true);
    assert.equal(pathCovered("/a/b", false, "/a/b/c/d"), false);
    assert.equal(pathCovered("/a/b", false, "/a/b"), false);
  });
  it("refuses relative, dot, NUL, case and sibling-prefix forms", T, () => {
    for (const t of ["a/b/c", "/a/b/../c", "/a/b/./c", "/a/b/c\0", "/A/b/c", "/a/bc/x", ""]) assert.equal(pathCovered("/a/b", true, t), false, t);
  });
  it("accepts Windows drive and UNC forms, separators equal", T, () => {
    assert.equal(pathCovered("C:\\Users\\c\\proj", true, "C:\\Users\\c\\proj\\a.txt"), true);
    assert.equal(pathCovered("C:\\Users\\c\\proj", true, "c:\\Users\\c\\proj\\a.txt"), false);
    assert.equal(pathCovered("\\\\srv\\share", true, "\\\\srv\\share\\x"), true);
  });
});

describe("surface trust T0–T3", () => {
  const req = (capability: string, f = flags()): Pick<ApprovalRequest, "capability" | "risk" | "flags"> => ({ capability, flags: f, risk: riskOf(CAPABILITIES.get(capability)!, f) });
  it("T0 decides nothing", T, () => {
    for (const id of ["fs.read", "fs.delete", "money.spend"]) assert.equal(surfaceMayDecide(req(id), 0, "once"), false);
  });
  it("T1 (editor) decides low-risk reads, writes and clipboard only", T, () => {
    assert.equal(surfaceMayDecide(req("clipboard.read"), 1, "session"), true);
    assert.equal(surfaceMayDecide(req("fs.read"), 1, "once"), true);
    assert.equal(surfaceMayDecide(req("fs.read", flags(OUT)), 1, "once"), true); // low: a read stays low outside roots
    assert.equal(surfaceMayDecide(req("fs.write", flags(OUT)), 1, "once"), false); // medium
    assert.equal(surfaceMayDecide(req("shell.exec"), 1, "once"), false);
    assert.equal(surfaceMayDecide(req("fs.delete"), 1, "once"), false);
  });
  it("T2 decides up to high but not money, privilege, remote control, public publish, always-outside-roots", T, () => {
    assert.equal(surfaceMayDecide(req("fs.delete"), 2, "task"), true);
    assert.equal(surfaceMayDecide(req("comm.send"), 2, "session"), true);
    for (const id of ["money.spend", "os.privilege", "remote.control"]) assert.equal(surfaceMayDecide(req(id), 2, "once"), false, id);
    assert.equal(surfaceMayDecide(req("net.publish", flags({ publishPublic: true })), 2, "once"), false);
    assert.equal(surfaceMayDecide(req("fs.write", flags(OUT)), 2, "always"), false);
    assert.equal(surfaceMayDecide(req("fs.write", flags(OUT)), 2, "session"), true);
  });
  it("T3 decides everything decidable, within the ceiling", T, () => {
    assert.equal(surfaceMayDecide(req("money.spend"), 3, "once"), true);
    assert.equal(surfaceMayDecide(req("money.spend"), 3, "always"), false);
    assert.equal(surfaceMayDecide(req("remote.control"), 3, "always"), true);
  });
  it("unknown capability: nobody decides", T, () => assert.equal(surfaceMayDecide({ capability: "x", flags: flags(), risk: "low" }, 3, "once"), false));
  it("requiredSurface rises with scope and flags", T, () => {
    const fw = CAPABILITIES.get("fs.write")!;
    assert.equal(requiredSurface(fw, "once", flags()), 1);
    assert.equal(requiredSurface(fw, "always", flags(OUT)), 3);
    assert.equal(requiredSurface(fw, "once", flags({ systemTree: true })), 3);
  });
  it("ask echoes the origin surface and the narrowest required surface", T, () => {
    const r = run(call({ capability: "money.spend", effect: "money" }), ctx({ surface: 0 }));
    assert.equal(r.kind, "ask");
    if (r.kind === "ask") { assert.equal(r.request.originSurface, 0); assert.equal(r.request.requiredSurface, 3); assert.equal(r.request.risk, "critical"); }
  });
});

describe("taint, headless, fatigue, hand-offs", () => {
  const send = () => call({ capability: "comm.send", effect: "external" });
  it("a tainted turn without private data keeps its standing grants", T, () => {
    assert.equal(run(send(), ctx({ taint: { tainted: true, readPrivate: false } }), [grant("comm.send", "session")]).kind, "allow");
  });
  it("tainted + private data sets standing grants aside but honours a once for this exact action", T, () => {
    const x = ctx({ taint: { tainted: true, readPrivate: true } });
    const r = run(send(), x, [grant("comm.send", "session")]);
    assert.equal(r.kind, "ask");
    if (r.kind === "ask") { assert.equal(r.request.taintSuspended, true); assert.equal(r.request.tainted, true); }
    assert.equal(run(send(), x, [grant("comm.send", "once")]).kind, "allow");
  });
  it("headless parks instead of asking", T, () => {
    const r = run(call({ capability: "fs.delete" }), ctx({ headless: { jobId: "j" } }));
    assert.equal(r.kind, "ask");
    if (r.kind === "ask") assert.equal(r.park, true);
    const i = run(call({ capability: "fs.delete" }), ctx());
    if (i.kind === "ask") assert.equal(i.park, false);
  });
  it("headless once grants never apply (job standing grants only)", T, () => {
    assert.equal(run(call({ capability: "fs.delete" }), ctx({ headless: { jobId: "j" } }), [grant("fs.delete", "once")]).kind, "ask");
  });
  it("a sub-agent's own grants are keyed by its own agent id", T, () => {
    const x = ctx({ subject: { kind: "subagent", agentId: "sub" }, handoff: { scope: ["fs.delete"], taskId: "t1", approvalsHeld: [] } });
    assert.equal(run(call({ capability: "fs.delete" }), x, [grant("fs.delete", "task", undefined, { agent: "sub" })]).kind, "allow");
  });
  it("revocation is immediate: the very next decision asks again", T, () => {
    const g = grant("fs.delete", "task");
    const grants = new MemoryGrants([g]);
    const c = call({ capability: "fs.delete" });
    const deps = { grants, clock: new FakeClock() };
    assert.equal(decide(c, ctx(), deps).kind, "allow");
    g.revoked = true;
    assert.equal(decide(c, ctx(), deps).kind, "ask");
  });
  it("a consumed once is not allowed twice", T, () => {
    const g = grant("fs.delete", "once");
    const deps = { grants: new MemoryGrants([g]), clock: new FakeClock() };
    const c = call({ capability: "fs.delete" });
    assert.equal(decide(c, ctx(), deps).kind, "allow");
    g.consumedAt = NOW;
    assert.equal(decide(c, ctx(), deps).kind, "ask");
  });
});

describe("purity", () => {
  it("does not mutate its inputs and is deterministic", T, () => {
    const c = call({ capability: "fs.delete" });
    const x = ctx({ toolsDeny: ["a"], overrides: { "fs.read": "allowed" } });
    const g = [grant("fs.delete", "task")];
    const snap = JSON.stringify([c, x, g]);
    const a = run(c, x, g);
    const b = run(c, x, g);
    assert.equal(JSON.stringify([c, x, g]), snap);
    assert.deepEqual(a, b);
  });
  it("an ask request is a copy: mutating it cannot change the call's flags", T, () => {
    const c = call({ capability: "fs.delete" });
    const r = run(c, ctx()) as Extract<Decision, { kind: "ask" }>;
    r.request.flags.outsideRoots = true;
    assert.equal(c.flags.outsideRoots, false);
  });
});

describe("effect axis and taxonomy table", () => {
  it("maps D103 sideEffects", T, () => {
    assert.deepEqual([fromSideEffects("none"), fromSideEffects("local"), fromSideEffects("local", true), fromSideEffects("external"), fromSideEffects("money")], ["read", "local-write", "local-destructive", "external", "money"]);
    assert.equal(fromSideEffects("bogus" as never), "external");
  });
  it("maps extension effects", T, () => {
    assert.equal(fromExtensionEffect("read", "none"), "read");
    assert.equal(fromExtensionEffect("write", "none"), "local-write");
    assert.equal(fromExtensionEffect("write", undefined), "external");
    assert.equal(fromExtensionEffect("destructive", "none"), "local-destructive");
    assert.equal(fromExtensionEffect("destructive", "declared"), "external");
  });
  it("MCP: undeclared is external, annotations only raise", T, () => {
    assert.equal(fromMcp(undefined), "external");
    assert.equal(fromMcp(undefined, { readOnlyHint: true }), "external");
    assert.equal(fromMcp("read", { destructiveHint: true }), "local-destructive");
    assert.equal(fromMcp("read", { openWorldHint: true }), "external");
    assert.equal(fromMcp("money", { openWorldHint: true }), "money");
  });
  it("every capability row is complete and consistent", T, () => {
    for (const d of CAPABILITIES.values()) {
      assert.ok(EFFECTS.includes(d.intrinsicEffect), d.id);
      if (d.base.inside === "never") assert.deepEqual([d.base.outside, d.ceiling, d.minSurface, d.lowerable], ["never", null, null, false], d.id);
      if (d.minSurface === 3 || d.ceiling === "once") assert.equal(d.lowerable, false, d.id);
    }
  });
  it("matches the spec's defaults", T, () => {
    const g = (id: string) => CAPABILITIES.get(id)!;
    assert.deepEqual(g("fs.read").base, { inside: "allowed", outside: "approval" });
    assert.deepEqual(g("fs.write").base, { inside: "allowed", outside: "approval" });
    assert.equal(g("sys.read").base.inside, "allowed");
    assert.equal(g("net.fetch").base.inside, "allowed");
    assert.equal(g("money.spend").ceiling, "once");
    assert.equal(g("fs.delete").ceiling, "task");
    assert.equal(g("proc.signal").ceiling, "session");
    assert.deepEqual([...NEVER_CAPABILITIES].sort(), ["captcha.solve", "credential.entry", "harness.admin", "input.monitor", "policy.bypass"]);
  });
});

describe("review hardening (#121)", () => {
  it("capability names are case-folded to one canonical form", T, () => {
    assert.equal(run(call({ capability: "FS.Read" }), ctx()).kind, "allow");
    assert.equal(run(call({ capability: "Harness.Admin" }), ctx()).kind, "deny");
    assert.equal(run(call({ capability: "fs.read" }), ctx({ toolsDeny: ["FS.*"] })).kind, "deny");
    assert.equal(run(call({ capability: "fs.write", targets: ["/x"] }), ctx({ tokenScopes: ["FS.WRITE"] })).kind, "allow");
  });
  it("tools.deny globs: '*' anywhere, regex characters stay literal", T, () => {
    assert.equal(run(call({ tool: "mcp.search" }), ctx({ toolsDeny: ["mcp.*"] })).kind, "deny");
    assert.equal(run(call({ tool: "mcpxsearch" }), ctx({ toolsDeny: ["mcp.search"] })).kind, "allow"); // '.' is not a wildcard
    assert.equal(run(call(), ctx({ toolsDeny: ["f*.read"] })).kind, "deny");
    assert.equal(run(call(), ctx({ toolsDeny: ["(fs"] })).kind, "allow");
  });
  it("a non-string tools.deny entry fails closed", T, () => {
    assert.deepEqual(run(call(), ctx({ toolsDeny: [42 as never] })), { kind: "deny", reason: "policy-never", rule: "tools.deny:invalid" });
  });
  it("invalid grants are no grants: non-finite times, bad surface, bad scope, bad match, future creation", T, () => {
    const c = call({ capability: "fs.delete" });
    const mut = (o: Record<string, unknown>) => ({ ...grant("fs.delete", "task"), ...o }) as never;
    for (const bad of [{ createdAt: Infinity }, { lastUsedAt: NaN }, { surface: 7 }, { surface: "3" }, { scope: "forever" }, { match: null }, { match: { kind: "path", path: "", access: "read", recursive: true } }, { id: "" }, { createdAt: NOW + HOUR }]) {
      assert.equal(run(c, ctx(), [mut(bad)]).kind, "ask", JSON.stringify(bad));
    }
    assert.equal(run(c, ctx(), [grant("fs.delete", "task")], new FakeClock(NaN)).kind, "ask");
  });
  it("an unknown effect is treated as money", T, () => {
    const r = run(call({ capability: "sys.read", effect: "Money" as never }), ctx());
    assert.equal(r.kind, "ask");
    if (r.kind === "ask") assert.equal(r.request.effect, "money");
  });
  it("overrides: 'approval' still raises, 'allowed' only applies inside the roots, the stricter duplicate wins", T, () => {
    assert.equal(run(call(), ctx({ overrides: { "fs.read": "approval" } })).kind, "ask");
    assert.equal(run(outRead(), ctx({ overrides: { "fs.read": "allowed" } })).kind, "ask");
    assert.equal(run(call({ capability: "shell.exec", flags: { sandboxed: true } }), ctx({ overrides: { "shell.exec": "allowed" } })).kind, "allow");
    assert.equal(run(call({ capability: "shell.exec", flags: { sandboxed: true } }), ctx({ overrides: { "shell.exec": "allowed", "SHELL.EXEC": "approval" } })).kind, "ask");
  });
});
