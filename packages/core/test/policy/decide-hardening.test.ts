// B08 audit: fail-closed gaps in decide() found by reading the evaluator against D109 (each block was red before its fix).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { surfaceMayDecide, type ApprovalRequest, type Decision } from "../../src/policy/index.ts";
import { DAY, NOW, call, ctx, grant, run } from "./helpers.ts";

const isDeny = (d: Decision, rule?: string): boolean => d.kind === "deny" && (rule === undefined || d.rule === rule);

describe("tools.deny matching", () => {
  it("a glob also matches a tool name that contains a line break", () => {
    // `.` does not match "\n": a server-chosen tool name with a newline in it would slip past `mcp*`.
    assert.ok(isDeny(run(call({ tool: "mcp\nsearch" }), ctx({ toolsDeny: ["mcp*"] })), "tools.deny"));
    assert.ok(isDeny(run(call({ tool: "mcp.search x" }), ctx({ toolsDeny: ["mcp.*"] })), "tools.deny"));
  });
  it("a tools.deny that is not an array fails closed instead of being iterated or ignored", () => {
    for (const bad of ["fs.read", { 0: "fs.read" }, 7, null]) {
      assert.deepEqual(run(call(), ctx({ toolsDeny: bad as never })), { kind: "deny", reason: "policy-never", rule: "tools.deny:invalid" }, JSON.stringify(bad));
    }
  });
  it("many consecutive wildcards do not blow up the matcher", () => {
    const t0 = Date.now();
    // With the regex translation, 8 wildcards over a 40-character name took about 8 s; the guard is generous.
    const d = run(call({ tool: "a".repeat(40) + "c" }), ctx({ toolsDeny: ["*a".repeat(7) + "*b"] }));
    assert.equal(d.kind, "allow");
    assert.ok(Date.now() - t0 < 500, `catastrophic backtracking: ${Date.now() - t0} ms`);
  });
});

describe("stored grants", () => {
  const fsw = () => call({ capability: "fs.write", flags: { outsideRoots: true }, targets: ["/data/x"], access: "write" });
  const cap = () => grant("fs.write", "always", { kind: "path", path: "/data", access: "write", recursive: true });
  it("control: the unmodified grant allows", () => assert.equal(run(fsw(), ctx(), [cap()]).kind, "allow"));
  it("a revoked marker that is not the boolean true (SQLite 1, 'true') still revokes", () => {
    for (const v of [1, "true", "1", {}]) {
      const g = cap();
      (g as unknown as { revoked: unknown }).revoked = v;
      assert.notEqual(run(fsw(), ctx(), [g]).kind, "allow", JSON.stringify(v));
    }
  });
  it("a lastUsedAt in the future cannot stretch the expiry", () => {
    const g = grant("fs.write", "always", { kind: "path", path: "/data", access: "write", recursive: true }, { createdAt: NOW - 400 * DAY, lastUsedAt: NOW + 1000 * DAY });
    assert.notEqual(run(fsw(), ctx(), [g]).kind, "allow");
  });
});

describe("approval request carries what decided it", () => {
  it("a batch derived from the number of targets is recorded in request.flags, so surfaceMayDecide caps the scope at once", () => {
    const targets = Array.from({ length: 25 }, (_, i) => `/work/proj/f${i}.txt`);
    const d = run(call({ capability: "fs.write", targets, access: "write" }), ctx());
    assert.equal(d.kind, "ask");
    const req = (d as Extract<Decision, { kind: "ask" }>).request as ApprovalRequest;
    assert.deepEqual(req.grantOptions.map((o) => o.scope), ["once"]);
    assert.equal(surfaceMayDecide(req, 3, "once"), true);
    assert.equal(surfaceMayDecide(req, 3, "session"), false);
    assert.equal(surfaceMayDecide(req, 3, "always"), false);
  });
});

describe("malformed call and context are refused, not half-evaluated", () => {
  const rule = "invalid-call";
  it("flags that are missing or not booleans", () => {
    for (const bad of [undefined, null, "x", [], { denyListHit: false }, { outsideRoots: false }, { outsideRoots: 0, denyListHit: false }, { outsideRoots: false, denyListHit: "no" }, { outsideRoots: false, denyListHit: false, privileged: "yes" }, { outsideRoots: false, denyListHit: false, batch: 1 }]) {
      const c = call(); (c as unknown as { flags: unknown }).flags = bad;
      assert.ok(isDeny(run(c, ctx()), rule), JSON.stringify(bad));
    }
  });
  it("a tool name or action hash that is not a string", () => {
    for (const k of ["tool", "actionHash"] as const) {
      const c = call(); (c as unknown as Record<string, unknown>)[k] = 5;
      assert.ok(isDeny(run(c, ctx()), rule), k);
    }
  });
  it("a subject kind outside the vocabulary (a spelling of a2a-peer must not become a plain agent)", () => {
    for (const kind of ["A2A-peer", "a2a_peer", "", "root"]) {
      assert.ok(isDeny(run(call(), ctx({ subject: { kind: kind as never, agentId: "bernd" } })), "invalid-context"), kind);
    }
  });
  it("a headless context without a job id would match any grant that has no job id", () => {
    const g = () => grant("os.grant", "always", { kind: "capability" });
    assert.deepEqual(run(call({ capability: "os.grant" }), ctx(), [g()]).kind, "allow"); // control: the grant itself works
    for (const bad of [{}, { jobId: "" }, { jobId: 3 }]) {
      assert.ok(isDeny(run(call({ capability: "os.grant" }), ctx({ headless: bad as never }), [g()]), "invalid-context"), JSON.stringify(bad));
    }
  });
  it("token scopes and hand-off scopes that are not lists of strings", () => {
    assert.ok(isDeny(run(call(), ctx({ tokenScopes: "fs.read" as never })), "invalid-context"));
    assert.ok(isDeny(run(call(), ctx({ tokenScopes: ["fs.read", 4 as never] })), "invalid-context"));
    const sub = ctx({ subject: { kind: "subagent", agentId: "sub" }, handoff: { scope: ["fs.read", null as never], taskId: "t1", approvalsHeld: [] } });
    assert.ok(isDeny(run(call(), sub), "invalid-context"));
  });
  it("a prompt counter that is not a number cannot switch the fatigue cap off", () => {
    const c = call({ capability: "shell.exec" });
    for (const n of [NaN, "12", undefined as never]) {
      const d = run(c, ctx({ promptsThisHour: n as never }));
      if (n === undefined) assert.equal(d.kind, "ask");
      else assert.ok(isDeny(d), String(n));
    }
    assert.ok(isDeny(run(c, ctx({ promptsThisHour: 10 })), "fatigue:prompt-cap"));
  });
});
