// B08 audit: path layer fails that silently weakened the deny-list or the "home is never a root" rule.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalisePath } from "../../src/policy/paths-index.ts";
import type { DenyEntry, PathResult } from "../../src/policy/paths-index.ts";

const T = { timeout: 30_000 };
let base = "";
let root = "";

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "p1b-b08-")));
  root = join(base, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "a.txt"), "a");
});
after(async () => { await rm(base, { recursive: true, force: true }); });

function refused(r: PathResult, reason: string): string {
  assert.equal(r.ok, false, `expected refusal ${reason}, got ${r.ok ? r.canonical : ""}`);
  if (r.ok) return "";
  assert.equal(r.reason, reason, r.detail);
  return r.detail;
}

describe("deny-list entries that cannot work are refused, not skipped", () => {
  const entries: [string, unknown][] = [
    ["a name with a separator (never equals one segment)", { name: ".ssh/config" }],
    ["a name with a backslash", { name: ".ssh\\config" }],
    ["an empty name", { name: "" }],
    ["a dot name", { name: ".." }],
    ["an empty path", { path: "" }],
    ["a relative path (a ~ or an unset variable that was never expanded)", { path: "~/.ssh" }],
    ["a relative path without tilde", { path: "secrets/key" }],
    ["a non-string name", { name: 7 }],
    ["neither name nor path", { glob: "*.pem" }],
    ["null", null],
    ["a string", ".env"],
  ];
  for (const [what, entry] of entries) {
    it(what, T, async () => {
      const detail = refused(await canonicalisePath(join(root, "sub", "a.txt"), { roots: [{ id: "ws", path: root }], deny: [entry as DenyEntry] }), "deny-listed");
      assert.match(detail, /invalid deny-list entry/);
    });
  }
  it("valid entries still work (control)", T, async () => {
    const r = await canonicalisePath(join(root, "sub", "a.txt"), { roots: [{ id: "ws", path: root }], deny: [{ name: ".env" }, { path: join(base, "elsewhere") }] });
    assert.equal(r.ok, true);
  });
  it("a deny list that is not an array is refused", T, async () => {
    refused(await canonicalisePath(join(root, "sub", "a.txt"), { roots: [{ id: "ws", path: root }], deny: { name: ".env" } as never }), "deny-listed");
  });
});

describe("home is never a root, even when it is a symbolic link", { skip: process.platform === "win32" }, () => {
  it("the home directory spelled through a link", T, async () => {
    const real = join(base, "data", "u");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "f.txt"), "f");
    const link = join(base, "home-u");
    await symlink(real, link);
    // home is the link (what os.homedir() reports), the root is the real directory, and the other way round
    refused(await canonicalisePath(join(real, "f.txt"), { roots: [{ id: "h", path: real }], home: link }), "bad-root");
    refused(await canonicalisePath(join(real, "f.txt"), { roots: [{ id: "h", path: link }], home: real }), "bad-root");
    refused(await canonicalisePath(join(real, "f.txt"), { roots: [{ id: "h", path: link }], home: link }), "bad-root");
    // a directory below home is still fine
    await mkdir(join(real, "work"));
    await writeFile(join(real, "work", "g.txt"), "g");
    const ok = await canonicalisePath(join(link, "work", "g.txt"), { roots: [{ id: "w", path: join(link, "work") }], home: link });
    assert.equal(ok.ok, true);
  });
});
