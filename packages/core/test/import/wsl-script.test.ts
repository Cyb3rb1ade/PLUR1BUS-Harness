// core/import wsl.ts shell scripts run for real with /bin/sh, tar and find against temporary trees (no wsl.exe): the probe script
// (which installations does a distro have) and the tar script (WSL_TAR_FIND_SCRIPT: what may leave a distro). These are the
// path-traversal and symlink-escape checks that matter most, because the script is the only thing between a hostile subpath or
// symlink inside the source and the files outside the source root. snapshot.test.ts has the end-to-end WSL branch with a fake
// wsl.exe; here the script's exit codes and tar listings are asserted directly.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import path from "node:path";
import { PROBE_SCRIPT, WSL_TAR_FIND_SCRIPT } from "../../src/import/wsl.ts";
import { useTempDirs } from "./helpers.ts";

const tmpDir = useTempDirs();
const probeTools = spawnSync("sh", ["-c", "command -v tar && command -v find && command -v mktemp && tar -cf /dev/null --null -T /dev/null </dev/null"], { encoding: "utf8" });
const skip = process.platform === "win32" ? "needs a POSIX shell" : probeTools.status !== 0 ? "tar --null, find or mktemp missing on this host" : undefined;
const MARKER = "redact-probe-alpha";

/** Runs the tar script the way spawnWslTarStream does (sh -c SCRIPT sh <root> -- <subpaths>) and lists the archive with the system tar. */
function runTar(root: string, subpaths: string[], extra: { cwd?: string } = {}) {
  const r = spawnSync("sh", ["-c", WSL_TAR_FIND_SCRIPT, "sh", root, "--", ...subpaths], { encoding: "buffer", timeout: 20_000, cwd: extra.cwd });
  let entries: string[] = [];
  if (r.status === 0) {
    const ls = spawnSync("tar", ["-tf", "-"], { input: r.stdout, encoding: "utf8", timeout: 20_000, env: { ...process.env, LC_ALL: "C.UTF-8" } });
    assert.equal(ls.status, 0, `tar -t failed: ${ls.stderr}`);
    entries = ls.stdout.split("\n").filter(Boolean).sort();
  }
  return { status: r.status, stderr: r.stderr.toString("utf8"), entries, tar: r.stdout };
}

describe("WSL_TAR_FIND_SCRIPT: what is archived", { skip }, () => {
  it("archives regular files and directories below the root, with relative './' names", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "sub", "deeper"), { recursive: true });
    writeFileSync(path.join(d, "top.md"), "t");
    writeFileSync(path.join(d, "sub", "deeper", "f.md"), "f");
    const r = runTar(d, ["."]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.entries, ["./", "./sub/", "./sub/deeper/", "./sub/deeper/f.md", "./top.md"]);
  });

  it("no subpath argument means the whole root", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "a"), "a");
    const r = runTar(d, []);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.entries, ["./", "./a"]);
  });

  it("only the named subpaths are archived (a file and a directory)", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "keep"));
    mkdirSync(path.join(d, "skip"));
    writeFileSync(path.join(d, "keep", "k.md"), "k");
    writeFileSync(path.join(d, "skip", "s.md"), "s");
    writeFileSync(path.join(d, "single.md"), "x");
    const r = runTar(d, ["./keep", "./single.md"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.entries, ["./keep/", "./keep/k.md", "./single.md"]);
  });

  it("symlinks inside the tree are never archived (neither to files nor to directories, nor dangling ones), so their targets do not leave the distro", () => {
    const d = tmpDir(); const outside = tmpDir();
    writeFileSync(path.join(outside, "secret.md"), `secret ${MARKER}`);
    mkdirSync(path.join(outside, "dir"));
    writeFileSync(path.join(outside, "dir", "inner.md"), `inner ${MARKER}`);
    mkdirSync(path.join(d, "root"));
    writeFileSync(path.join(d, "root", "regular.md"), "ok");
    symlinkSync(path.join(outside, "secret.md"), path.join(d, "root", "file-link.md"));
    symlinkSync(path.join(outside, "dir"), path.join(d, "root", "dir-link"));
    symlinkSync(path.join(d, "nowhere"), path.join(d, "root", "dangling"));
    symlinkSync(path.join(d, "root", "regular.md"), path.join(d, "root", "inside-link.md"));
    const r = runTar(path.join(d, "root"), ["."]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.entries, ["./", "./regular.md"]);
    assert.ok(!r.tar.toString("latin1").includes(MARKER), "no byte of the outside files is in the stream");
  });

  it("FIFOs, hard links to outside files are handled as what they are: a FIFO is skipped, a hard link is a regular file", () => {
    const d = tmpDir(); const outside = tmpDir();
    mkdirSync(path.join(d, "root"));
    spawnSync("mkfifo", [path.join(d, "root", "pipe")]);
    writeFileSync(path.join(outside, "target"), `hard ${MARKER}`);
    linkSync(path.join(outside, "target"), path.join(d, "root", "hard.md"));
    const r = runTar(path.join(d, "root"), ["."]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.entries, ["./", "./hard.md"]);
  });

  it("file names with spaces, newlines, leading dashes, quotes and glob characters come through intact (NUL-delimited list)", () => {
    const d = tmpDir();
    const names = ["with space.md", "new\nline.md", "-dash.md", "quo'te\".md", "glob*?[x].md", "$(touch pwned).md", "semi;colon.md"];
    for (const n of names) writeFileSync(path.join(d, n), "x");
    const r = runTar(d, ["."]);
    assert.equal(r.status, 0, r.stderr);
    // the system tar prints a newline inside a name as an escaped \n
    const expected = ["./", ...names.map((n) => "./" + n.replace("\n", "\\n"))].sort();
    assert.deepEqual(r.entries, expected);
    assert.ok(!r.entries.includes("./pwned"));
  });

  it("works from any current directory (it cd's into the root itself)", () => {
    const d = tmpDir(); const elsewhere = tmpDir();
    writeFileSync(path.join(d, "a"), "a");
    assert.deepEqual(runTar(d, ["."], { cwd: elsewhere }).entries, ["./", "./a"]);
  });
});

describe("WSL_TAR_FIND_SCRIPT: refusals (exit 3 unless noted)", { skip }, () => {
  function tree() {
    const d = tmpDir(); const outside = tmpDir();
    mkdirSync(path.join(d, "root", "sub"), { recursive: true });
    writeFileSync(path.join(d, "root", "sub", "in.md"), "in");
    writeFileSync(path.join(d, "root", "top.md"), "t");
    writeFileSync(path.join(d, "outside-sibling.md"), `sibling ${MARKER}`);
    mkdirSync(path.join(outside, "dir"));
    writeFileSync(path.join(outside, "dir", "secret.md"), `secret ${MARKER}`);
    writeFileSync(path.join(outside, "file.md"), `file ${MARKER}`);
    symlinkSync(path.join(outside, "dir"), path.join(d, "root", "dir-link"));
    symlinkSync(path.join(outside, "file.md"), path.join(d, "root", "file-link.md"));
    symlinkSync(path.join(d, "root", "sub"), path.join(d, "root", "inside-dir-link"));
    return { root: path.join(d, "root"), d, outside };
  }
  const expectRefused = (root: string, subpaths: string[], status = 3) => {
    const r = runTar(root, subpaths);
    assert.equal(r.status, status, `${JSON.stringify(subpaths)}: ${r.stderr}`);
    assert.equal(r.tar.length, 0, "nothing was written to stdout");
    return r;
  };

  it("'..' in any position, and an absolute path", () => {
    const t = tree();
    for (const sp of ["..", "../outside-sibling.md", "sub/../../outside-sibling.md", "./..", "sub/..", "a/../b", t.d, path.join(t.outside, "file.md"), "/etc/passwd"]) {
      expectRefused(t.root, [sp]);
    }
  });

  it("a subpath that is a symlink to a directory outside the root", () => {
    const t = tree();
    const r = expectRefused(t.root, ["./dir-link"]);
    assert.ok(!r.tar.toString().includes(MARKER));
  });

  it("a subpath that goes through a symlinked directory to a file outside the root", () => {
    const t = tree();
    expectRefused(t.root, ["./dir-link/secret.md"]);
  });

  it("a subpath that is a file-symlink to a file outside the root: archived as nothing (a link is not a regular file), never as the target's bytes", () => {
    const t = tree();
    const r = runTar(t.root, ["./file-link.md"]);
    assert.ok(r.status === 0 || r.status === 3, r.stderr);
    assert.ok(!r.tar.toString("latin1").includes(MARKER));
    assert.deepEqual(r.entries.filter((e) => e.includes("file-link")), []);
  });

  it("a subpath that is a directory symlink that stays inside the root is accepted (its real path is below the root)", () => {
    const t = tree();
    const r = runTar(t.root, ["./inside-dir-link"]);
    assert.equal(r.status, 0, r.stderr);
  });

  it("a missing subpath fails (no silent empty snapshot); a missing root fails with exit 1", () => {
    const t = tree();
    expectRefused(t.root, ["./does-not-exist"]);
    expectRefused(t.root, ["./top.md", "./does-not-exist"]);
    const r = runTar(path.join(t.d, "no-such-root"), ["."]);
    assert.equal(r.status, 1);
    assert.equal(r.tar.length, 0);
  });

  it("one bad subpath among good ones refuses the whole call before any byte is written", () => {
    const t = tree();
    expectRefused(t.root, ["./top.md", "./sub", "../outside-sibling.md"]);
  });

  it("a root that is itself reached through a symlink is fine (the real root is compared), a subpath may not escape that real root", () => {
    const t = tree();
    const alias = path.join(t.d, "root-alias");
    symlinkSync(t.root, alias);
    assert.equal(runTar(alias, ["."]).status, 0);
    assert.equal(runTar(alias, ["./dir-link"]).status, 3);
    assert.equal(runTar(alias, ["../outside-sibling.md"]).status, 3);
  });

  it("the TypeScript validation and the script agree: everything validateAndNormalizeSubpaths refuses, the script refuses too when given raw", async () => {
    const { validateAndNormalizeSubpaths } = await import("../../src/import/wsl.ts");
    const t = tree();
    for (const sp of ["..", "../x", "a/../b", "/etc", "sub/.."]) {
      assert.throws(() => validateAndNormalizeSubpaths([sp]), { reason: "invalid-subpath" }, sp);
      expectRefused(t.root, [sp]);
    }
  });
});

describe("WSL_TAR_FIND_SCRIPT: environment checks", { skip }, () => {
  function withFakeBin(missing: string[]) {
    // a PATH with symlinks to the real tools minus the missing ones
    const bin = tmpDir();
    for (const tool of ["sh", "dirname", "basename", "pwd", "grep", "rm", "cat", "tar", "find", "mktemp", "env", "true", "false", "test", "[", "echo", "printf", "head", "sed", "cd"]) {
      if (missing.includes(tool)) continue;
      const which = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (which.startsWith("/")) { try { symlinkSync(which, path.join(bin, tool)); } catch { /* already there */ } }
    }
    return bin;
  }
  for (const tool of ["mktemp", "find", "tar"]) {
    it(`a distro without ${tool} fails with exit 4 and 'wsl-tools-missing (${tool})' on stderr`, () => {
      const d = tmpDir();
      writeFileSync(path.join(d, "a"), "a");
      const bin = withFakeBin([tool]);
      const r = spawnSync(path.join(bin, "sh"), ["-c", WSL_TAR_FIND_SCRIPT, "sh", d, "--", "."], { encoding: "utf8", env: { PATH: bin }, timeout: 20_000 });
      assert.equal(r.status, 4, r.stderr);
      assert.match(r.stderr, new RegExp(`wsl-tools-missing \\(${tool}`));
      assert.equal(r.stdout, "");
    });
  }
});

describe("PROBE_SCRIPT (run with a controlled HOME)", { skip }, () => {
  /** The first records are for $HOME; the loop over /home/* adds records of the real host's other users, which this test ignores. */
  function probe(home: string, env: Record<string, string> = {}) {
    const r = spawnSync("sh", ["-c", PROBE_SCRIPT], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, ...env }, timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\0").filter(Boolean);
  }

  it("announces HOME first, then the OpenClaw and Hermes directories that exist", () => {
    const home = tmpDir();
    mkdirSync(path.join(home, ".openclaw")); mkdirSync(path.join(home, ".hermes"));
    assert.deepEqual(probe(home).slice(0, 3), [`HOME=${home}`, `OPENCLAW=${home}/.openclaw`, `HERMES=${home}/.hermes`]);
  });

  it("nothing installed: only the HOME record comes first", () => {
    const home = tmpDir();
    assert.equal(probe(home)[0], `HOME=${home}`);
    assert.ok(!probe(home).slice(0, 2).some((r) => r.startsWith("OPENCLAW=") || r.startsWith("HERMES=") && r.includes(home)));
  });

  it("the legacy .clawdbot directory counts when .openclaw is absent, and .openclaw wins when both exist", () => {
    const home = tmpDir();
    mkdirSync(path.join(home, ".clawdbot"));
    assert.deepEqual(probe(home).slice(0, 2), [`HOME=${home}`, `OPENCLAW=${home}/.clawdbot`]);
    mkdirSync(path.join(home, ".openclaw"));
    assert.deepEqual(probe(home).slice(0, 2), [`HOME=${home}`, `OPENCLAW=${home}/.openclaw`]);
  });

  it("OPENCLAW_STATE_DIR and HERMES_HOME override the defaults, but only when the directory exists", () => {
    const home = tmpDir(); const elsewhere = tmpDir();
    mkdirSync(path.join(home, ".openclaw")); mkdirSync(path.join(home, ".hermes"));
    mkdirSync(path.join(elsewhere, "oc")); mkdirSync(path.join(elsewhere, "hm"));
    const out = probe(home, { OPENCLAW_STATE_DIR: path.join(elsewhere, "oc"), HERMES_HOME: path.join(elsewhere, "hm") });
    assert.deepEqual(out.slice(0, 3), [`HOME=${home}`, `OPENCLAW=${path.join(elsewhere, "oc")}`, `HERMES=${path.join(elsewhere, "hm")}`]);
    const missing = probe(home, { HERMES_HOME: path.join(elsewhere, "missing") });
    assert.ok(!missing.slice(0, 3).some((r) => r.startsWith("HERMES=")), "an override that does not exist hides the default as well");
  });

  it("a path with a newline survives because records are NUL-delimited", () => {
    const base = tmpDir();
    const home = path.join(base, "home\nwith newline");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    assert.deepEqual(probe(home).slice(0, 2), [`HOME=${home}`, `OPENCLAW=${home}/.openclaw`]);
  });
});
