// D109 Q17 / spec §3 "Shell": roots bind `shell.exec` only through the OS sandbox, because arguments cannot be parsed. A path grant on the
// cwd (what an approval of `exec.run` produces) must therefore not replace the sandbox / "not sandboxed" acknowledgement: only the
// capability branch used to check it, and an approval never produces a capability grant.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, ctx, grant, run } from "./helpers.ts";

const T = { timeout: 15_000 };
const cwd = "/data/proj/x";
const exec = (flags: { sandboxed?: boolean } = {}) =>
  call({ capability: "shell.exec", tool: "exec.run", effect: "local-write", targets: [cwd], access: "write", flags: { outsideRoots: true, ...flags } });
const pathGrant = (scope: "session" | "always" | "task", o: Record<string, unknown> = {}) =>
  grant("shell.exec", scope, { kind: "path", path: "/data/proj", access: "write", recursive: true }, o);

describe("shell.exec path grants and the sandbox", () => {
  for (const scope of ["task", "session", "always"] as const) {
    it(`${scope}: without a sandbox a path grant that was not acknowledged does not apply (the call asks again)`, T, () => {
      for (const sandboxed of [undefined, false]) {
        const d = run(exec(sandboxed === undefined ? {} : { sandboxed }), ctx(), [pathGrant(scope)]);
        assert.equal(d.kind, "ask", `sandboxed=${String(sandboxed)}`);
      }
    });
    it(`${scope}: without a sandbox an acknowledged path grant applies`, T, () => {
      const d = run(exec({ sandboxed: false }), ctx(), [pathGrant(scope, { acknowledgedUnsandboxed: true })]);
      assert.equal(d.kind, "allow");
      if (d.kind === "allow") assert.equal(d.via, "grant");
    });
    it(`${scope}: on a sandboxed host a path grant applies without the acknowledgement (legitimate use keeps working)`, T, () => {
      const d = run(exec({ sandboxed: true }), ctx(), [pathGrant(scope)]);
      assert.equal(d.kind, "allow");
    });
  }
  it("the capability branch is unchanged: needs a sandbox or the acknowledgement, and stays inside the roots", T, () => {
    const cap = (o: Record<string, unknown> = {}) => grant("shell.exec", "always", { kind: "capability" }, o);
    const inside = (sandboxed?: boolean) => call({ capability: "shell.exec", flags: sandboxed === undefined ? {} : { sandboxed } });
    assert.equal(run(inside(), ctx(), [cap()]).kind, "ask");
    assert.equal(run(inside(true), ctx(), [cap()]).kind, "allow");
    assert.equal(run(inside(false), ctx(), [cap({ acknowledgedUnsandboxed: true })]).kind, "allow");
    assert.equal(run(exec({ sandboxed: true }), ctx(), [cap()]).kind, "ask", "a capability grant never covers a call outside the roots");
  });
  it("path grants of other capabilities are not affected by the shell rule", T, () => {
    const c = call({ capability: "fs.write", tool: "file.write", targets: ["/data/proj/a.txt"], access: "write", flags: { outsideRoots: true } });
    const g = grant("fs.write", "always", { kind: "path", path: "/data/proj", access: "write", recursive: true });
    assert.equal(run(c, ctx(), [g]).kind, "allow");
  });
  it("a path grant still has to cover the cwd and the access", T, () => {
    const g = pathGrant("always", { acknowledgedUnsandboxed: true });
    const elsewhere = call({ capability: "shell.exec", tool: "exec.run", targets: ["/other/dir"], access: "write", flags: { outsideRoots: true, sandboxed: true } });
    assert.equal(run(elsewhere, ctx(), [g]).kind, "ask");
  });
});
