// D109 §3: home, drive roots, `/`, `/Users`, `C:\Users` and system trees are never roots; a grant on them is T3 and at most `task`.
// Before: `systemTree` was set by no classifier and checked by no grant creator, so a T1 connection could mint an `always` read grant
// on the home directory (`grant.create`), and an approval at T2 with scope `always` or `session` did the same for `/etc` or home.
// The store is the last line for every creation path; the RPC and the approval service fail early with the documented reasons.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrantError, GrantStore } from "../../src/grants/store.ts";
import { decide } from "../../src/policy/index.ts";
import { rpcRig, refused } from "../approvals/rpc-helpers.ts";
import { askFor, lastNonce, rig, tick } from "../approvals/service-helpers.ts";
import { alwaysCap, open } from "./helpers.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 20_000 };
const code = (c: string) => (e: unknown) => { assert.ok(e instanceof GrantError, String(e)); assert.equal(e.code, c, (e as Error).message); return true; };
const HOME = homedir();
const SYSTEM = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc";
const pathGrant = (path: string, recursive: boolean) => ({ kind: "path" as const, path, access: "read" as const, recursive });

describe("grant store: a path grant that reaches home or a system tree", () => {
  for (const [what, path] of [["the home directory", HOME], ["a system tree", SYSTEM]] as const) {
    for (const recursive of [false, true]) {
      it(`${what} (recursive ${recursive}): session and always exceed the ceiling, task needs T3`, T, async () => {
        const s = await open();
        const g = s.grants;
        assert.throws(() => g.create(alwaysCap({ scope: "always", match: pathGrant(path, recursive) })), code("ceiling-exceeded"));
        assert.throws(() => g.create(alwaysCap({ scope: "session", sessionId: "s1", match: pathGrant(path, recursive) })), code("ceiling-exceeded"));
        for (const surface of [1, 2] as const) {
          assert.throws(() => g.create(alwaysCap({ scope: "task", taskId: "t1", surface, match: pathGrant(path, recursive) })), code("surface-too-low"), `T${surface}`);
        }
        const ok = g.create(alwaysCap({ scope: "task", taskId: "t1", surface: 3, match: pathGrant(path, recursive) }));
        assert.equal(ok.scope, "task");
        assert.equal(g.list({ person: "christian", agent: "bernd", capability: "fs.read" }).length, 1, "only the T3 task grant exists");
      });
    }
  }
  it("a recursive grant on the directory that holds the home reaches it too; the home comes from the store's `home` option", T, async () => {
    const o = await open();
    const s = new GrantStore({ db: o.db, chain: o.chain, clock: o.clock, home: abs("/srv/people/u") });
    assert.throws(() => s.create(alwaysCap({ scope: "always", match: pathGrant(abs("/srv/people"), true) })), code("ceiling-exceeded"));
    assert.throws(() => s.create(alwaysCap({ scope: "always", match: pathGrant(abs("/srv/people/u"), false) })), code("ceiling-exceeded"));
    assert.equal(s.create(alwaysCap({ scope: "always", match: pathGrant(abs("/srv/people/u/work"), true) })).scope, "always");
    assert.equal(s.create(alwaysCap({ scope: "always", match: pathGrant(abs("/srv/people/other"), true) })).scope, "always");
  });
  it("control: a folder in home or an ordinary directory still takes an always grant", T, async () => {
    const s = await open();
    const a = s.grants.create(alwaysCap({ scope: "always", surface: 1, match: pathGrant(join(HOME, "Documents", "project"), true) }));
    const b = s.grants.create(alwaysCap({ scope: "session", sessionId: "s1", surface: 1, match: pathGrant(abs("/srv/data"), false) }));
    assert.deepEqual([a.scope, b.scope], ["always", "session"]);
  });
  it("capability and once grants are untouched (no path to classify)", T, async () => {
    const s = await open();
    s.grants.create(alwaysCap({ scope: "always", match: { kind: "capability" } }));
  });
});

describe("grant.create (RPC)", () => {
  it("T1 cannot mint an always or session read grant on home or a system tree: the scope is capped at task", T, async () => {
    const r = await rpcRig();
    for (const path of [HOME, SYSTEM]) {
      for (const recursive of [false, true]) {
        const m = { kind: "path", path, access: "read", recursive };
        assert.deepEqual(await refused(r.call("grant.create", { capability: "fs.read", agent: "bernd", scope: "always", match: m })), { error: "E_INVALID_PARAMS", reason: "ceiling-exceeded" }, `${path} ${recursive}`);
        assert.deepEqual(await refused(r.call("grant.create", { capability: "fs.read", agent: "bernd", scope: "session", sessionId: "s1", match: m })), { error: "E_INVALID_PARAMS", reason: "ceiling-exceeded" });
      }
    }
    assert.deepEqual(r.grantChanged, []);
  });
  it("a task grant on home needs T3: an unattested T1 connection is refused, an attested desktop app is not", T, async () => {
    const r = await rpcRig();
    const params = { capability: "fs.read", agent: "bernd", scope: "task", taskId: "t1", match: { kind: "path", path: HOME, access: "read", recursive: false } };
    assert.deepEqual(await refused(r.call("grant.create", params)), { error: "E_DENIED", reason: "surface-untrusted" });
    r.attestation = { kind: "desktop-app" };
    const g = await r.call("grant.create", params);
    assert.equal(g.scope, "task");
    assert.equal(g.surface, 3);
  });
  it("control: T1 still creates an always read grant on a folder inside home", T, async () => {
    const r = await rpcRig();
    const g = await r.call("grant.create", { capability: "fs.read", agent: "bernd", scope: "always", match: { kind: "path", path: join(HOME, "Documents", "project"), access: "read", recursive: true } });
    assert.equal(g.scope, "always");
    assert.equal(g.surface, 1);
  });
});

describe("approval decide with a standing scope", () => {
  const ask = async (targets: string[], flags: Record<string, boolean> = {}) => {
    const r = await rig();
    const answer = r.service.request(askFor({ targets, flags, access: "read" }));
    await tick();
    return { r, answer, ...lastNonce(r) };
  };
  const decideAs = (r: Awaited<ReturnType<typeof rig>>, id: string, nonce: string, scope: string, surface: number) =>
    r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface, scope } as never);

  it("a read of a system tree (classified systemTree) offers once and task only; always and session are refused, task needs T3", T, async () => {
    const target = join(SYSTEM, process.platform === "win32" ? "win.ini" : "hosts");
    const { r, answer, id, nonce } = await ask([target], { systemTree: true });
    assert.deepEqual(r.events.find((e) => e.name === "approval.requested")!.payload.approval.grantOptions.map((o: { scope: string }) => o.scope), ["once", "task"]);
    for (const scope of ["always", "session"]) assert.deepEqual(decideAs(r, id, nonce, scope, 3), { ok: false, reason: "scope-unavailable" }, scope);
    assert.deepEqual(decideAs(r, id, nonce, "task", 2), { ok: false, reason: "surface-untrusted" });
    assert.equal(r.stores.grants.inspect({ person: "christian" }).length, 0, "nothing was created by the refusals");
    const res = decideAs(r, id, nonce, "task", 3);
    assert.equal(res.ok, true);
    assert.equal(r.stores.grants.inspect({ person: "christian" }).length, 1);
    assert.equal((await answer).approved, true);
  });

  it("a file directly in the home directory: the grant would be on home, so always and session are refused by the store and the request stays pending", T, async () => {
    const { r, answer, id, nonce } = await ask([join(HOME, "notes.txt")]);
    for (const scope of ["always", "session"]) assert.deepEqual(decideAs(r, id, nonce, scope, 3), { ok: false, reason: "scope-unavailable" }, scope);
    assert.deepEqual(decideAs(r, id, nonce, "task", 2), { ok: false, reason: "surface-untrusted" }, "a task grant on home needs T3");
    assert.equal(r.stores.grants.inspect({ person: "christian" }).length, 0);
    assert.equal(decideAs(r, id, nonce, "once", 2).ok, true, "a once approval of this one read stays possible");
    assert.equal((await answer).approved, true);
  });

  it("control: a file in a folder outside the roots still takes always at T2 (the grant is on that folder)", T, async () => {
    const { r, answer, id, nonce } = await ask([join(HOME, "Documents", "a.txt")]);
    const res = decideAs(r, id, nonce, "always", 2);
    assert.equal(res.ok, true);
    const [g] = r.stores.grants.inspect({ person: "christian" });
    assert.deepEqual([g!.grant.scope, g!.grant.match.kind], ["always", "path"]);
    assert.equal((await answer).approved, true);
  });

  it("the evaluator offers the same cap: a call flagged systemTree has no always option", () => {
    const d = decide({ capability: "fs.read", tool: "file.read", flags: { outsideRoots: true, denyListHit: false, systemTree: true }, targets: [join(SYSTEM, "hosts")], access: "read", actionHash: "h" }, { principal: { person: "christian" }, subject: { kind: "agent", agentId: "bernd" }, surface: 3 }, { grants: { list: () => [], get: () => undefined }, clock: { now: () => 0 } });
    assert.equal(d.kind, "ask");
    if (d.kind === "ask") assert.deepEqual(d.request.grantOptions.map((o) => [o.scope, o.requiredSurface]), [["once", 3], ["task", 3]]);
  });
});
