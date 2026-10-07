// Store + decide() + the real path canonicaliser: roots, grants for further paths, deny-list precedence.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { canonicalisePath, isPathRefusal } from "../../src/policy/paths-index.ts";
import type { Call } from "../../src/policy/index.ts";
import { alwaysCap, call, ctx, decideWith, open } from "./helpers.ts";

const T = { timeout: 20_000 };

function world() {
  const base = realpathSync(tempDir("p1b-grants-"));
  const ws = join(base, "ws");
  const shared = join(base, "shared");
  const secret = join(base, "secrets");
  for (const d of [ws, shared, join(shared, "sub"), secret]) mkdirSync(d, { recursive: true });
  writeFileSync(join(shared, "a.txt"), "a");
  writeFileSync(join(shared, "sub", "b.txt"), "b");
  writeFileSync(join(secret, "token.env"), "x");
  writeFileSync(join(secret, "plain.txt"), "y");
  writeFileSync(join(ws, "own.txt"), "z");
  symlinkSync(secret, join(shared, "link-to-secrets"));
  const deny = [{ path: secret }, { name: ".env" }];
  const opts = (access: "read" | "write") => ({ roots: [{ id: "ws", path: ws }], deny, requireRoot: false, access, home: base });

  /** Builds the policy call the way the dispatcher will: canonicalise, then flags from the result. */
  async function toCall(input: string, access: "read" | "write" = "read"): Promise<Call> {
    const r = await canonicalisePath(input, opts(access));
    const capability = access === "read" ? "fs.read" : "fs.write";
    if (isPathRefusal(r)) {
      assert.equal(r.reason, "deny-listed", `${input}: ${r.reason}`);
      return call({ capability, tool: capability, access, targets: [input], flags: { outsideRoots: true, denyListHit: true } });
    }
    return call({ capability, tool: capability, access, targets: [r.canonical], flags: { outsideRoots: r.rootId === null, denyListHit: false } });
  }
  const canonDir = async (p: string) => { const r = await canonicalisePath(p, opts("read")); assert.ok(!isPathRefusal(r)); return (r as { canonical: string }).canonical; };
  return { ws, shared, secret, toCall, canonDir };
}

describe("store + decide() + canonicaliser (D109 §3/§4)", () => {
  it("inside the roots it is allowed; outside it is approval", T, async () => {
    const w = world();
    const s = await open();
    assert.deepEqual(decideWith(s, await w.toCall(join(w.ws, "own.txt")), ctx()), { kind: "allow", via: "default" });
    assert.equal(decideWith(s, await w.toCall(join(w.shared, "a.txt")), ctx()).kind, "ask");
  });

  it("a recursive read grant covers the subtree, not its siblings, and not writes", T, async () => {
    const w = world();
    const s = await open();
    const g = s.grants.create(alwaysCap({ match: { kind: "path", path: await w.canonDir(w.shared), access: "read", recursive: true } }));
    const allow = { kind: "allow", via: "grant", grantId: g.id };
    assert.deepEqual(decideWith(s, await w.toCall(join(w.shared, "a.txt")), ctx()), allow);
    assert.deepEqual(decideWith(s, await w.toCall(join(w.shared, "sub", "b.txt")), ctx()), allow);
    assert.equal(decideWith(s, await w.toCall(join(w.shared, "..", "ws2", "x")), ctx()).kind === "allow", false);
    assert.equal(decideWith(s, await w.toCall(join(w.shared, "a.txt"), "write"), ctx()).kind, "ask");
  });

  it("a non-recursive grant covers direct children only", T, async () => {
    const w = world();
    const s = await open();
    s.grants.create(alwaysCap({ match: { kind: "path", path: await w.canonDir(w.shared), access: "read", recursive: false } }));
    assert.equal(decideWith(s, await w.toCall(join(w.shared, "a.txt")), ctx()).kind, "allow");
    assert.equal(decideWith(s, await w.toCall(join(w.shared, "sub", "b.txt")), ctx()).kind, "ask");
  });

  it("a symlink inside a granted directory is decided on its target: the grant does not follow it out", T, async () => {
    const w = world();
    const s = await open();
    s.grants.create(alwaysCap({ match: { kind: "path", path: await w.canonDir(w.shared), access: "read", recursive: true } }));
    const d = decideWith(s, await w.toCall(join(w.shared, "link-to-secrets", "plain.txt")), ctx());
    assert.equal(d.kind, "deny"); // the target is under the deny-listed tree: deny-list first
  });

  it("the deny-list beats any grant, including a broad one on the parent", T, async () => {
    const w = world();
    const s = await open();
    const parent = join(w.secret, "..");
    s.grants.create(alwaysCap({ match: { kind: "path", path: await w.canonDir(parent), access: "read", recursive: true } }));
    s.grants.create(alwaysCap({ id: "cap", match: { kind: "capability" } }));
    for (const f of ["token.env", "plain.txt"]) {
      assert.deepEqual(decideWith(s, await w.toCall(join(w.secret, f)), ctx()), { kind: "deny", reason: "deny-list", rule: "deny-list" }, f);
    }
  });

  it("tools.deny and never capabilities beat grants too", T, async () => {
    const w = world();
    const s = await open();
    s.grants.create(alwaysCap({ match: { kind: "path", path: await w.canonDir(w.shared), access: "read", recursive: true } }));
    const c = await w.toCall(join(w.shared, "a.txt"));
    assert.deepEqual(decideWith(s, c, ctx({ toolsDeny: ["fs.*"] })), { kind: "deny", reason: "policy-never", rule: "tools.deny" });
    assert.equal(decideWith(s, call({ capability: "harness.admin", tool: "x" }), ctx()).kind, "deny");
  });

  it("revoking the grant sends the same call back to approval at once", T, async () => {
    const w = world();
    const s = await open();
    const g = s.grants.create(alwaysCap({ match: { kind: "path", path: await w.canonDir(w.shared), access: "read", recursive: true } }));
    const c = await w.toCall(join(w.shared, "a.txt"));
    assert.equal(decideWith(s, c, ctx()).kind, "allow");
    s.grants.revoke(g.id, "christian");
    assert.equal(decideWith(s, c, ctx()).kind, "ask");
  });
});
