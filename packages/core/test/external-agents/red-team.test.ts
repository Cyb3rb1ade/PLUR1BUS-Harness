import { provisionFixture, mountOptions } from "./fixture.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { containedRead, containedTerminal, containedWrite, gitDenyPaths } from "../../src/external-agents/containment.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function gitWorktree(root: string): { repo: string; worktree: string; home: string; outside: string } {
  const home = join(root, "home");
  const repo = join(root, "repo");
  let worktree: string;
  const outside = join(root, "outside.txt");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
  worktree = provisionFixture(home, repo);
  writeFileSync(outside, "safe");
  return { repo, worktree, home, outside };
}

test("filesystem escapes are refused: symlink, dotdot, absolute path and home", async () => {
  const root = tempDir("m6b-red-fs-");
  const { worktree, home, outside } = gitWorktree(root);
  const box = { worktree, home };
  symlinkSync(outside, join(worktree, "link"));
  await assert.rejects(() => containedWrite(box, join(worktree, "link"), "pwned"));
  await assert.rejects(() => containedRead(box, join(worktree, "link")));
  await assert.rejects(() => containedWrite(box, join(worktree, "..", "outside.txt"), "pwned"));
  await assert.rejects(() => containedWrite(box, outside, "pwned"));
  await assert.rejects(() => containedWrite(box, join(home, "escaped.txt"), "pwned"));
  assert.equal(readFileSync(outside, "utf8"), "safe");
  assert.equal(existsSync(join(home, "escaped.txt")), false);
});

test("windows 8.3 names, device names and ADS are refused by the path rules", async () => {
  const root = tempDir("m6b-red-win-");
  const { worktree, home } = gitWorktree(root);
  const box = { worktree, home, ...mountOptions(worktree), windowsRules: true };
  await assert.rejects(() => containedWrite(box, join(worktree, "CON"), "x"));
  await assert.rejects(() => containedWrite(box, join(worktree, "NOTES~1.TXT"), "x"));
  await assert.rejects(() => containedWrite(box, join(worktree, "ok.txt:secret"), "x"));
  assert.equal(existsSync(join(worktree, "CON")), false);
  assert.equal(existsSync(join(worktree, "ok.txt")), false);
});

test("an existing hard link refuses terminal/create and outside.txt stays safe", async () => {
  const root = tempDir("m6b-red-hl-");
  const { worktree, home, outside } = gitWorktree(root);
  linkSync(outside, join(worktree, "hard"));
  const result = await containedTerminal({ argv: ["/usr/bin/true"], worktree, home, ...mountOptions(worktree) });
  assert.deepEqual(result, { ok: false, reason: "hardlink-in-worktree" });
  assert.equal(readFileSync(outside, "utf8"), "safe");
});

test("a hard link attempted during the run fails and outside.txt stays safe", async () => {
  const root = tempDir("m6b-red-new-");
  const { worktree, home, outside } = gitWorktree(root);
  const script = join(worktree, "link.cjs");
  writeFileSync(script, `const fs = require("fs");
const [src, dst] = process.argv.slice(2);
try { fs.linkSync(src, dst); console.log("OK"); }
catch (e) { console.log(e.code); }
`);
  const dst = join(worktree, "new-hard");
  if (process.platform === "win32") {
    const refused = await containedTerminal({ argv: [process.execPath, script, outside, dst], worktree, home, ...mountOptions(worktree), platform: "win32" });
    assert.deepEqual(refused, { ok: false, reason: "sandbox-unavailable" });
  } else if (process.platform === "linux") {
    const hidden = join(root, "not-mounted.txt");
    writeFileSync(hidden, "safe");
    const missing = await containedTerminal({ argv: [process.execPath, script, hidden, dst], worktree, home, ...mountOptions(worktree), timeoutMs: 15_000 });
    assert.equal(missing.ok, true, JSON.stringify(missing));
    if (missing.ok) assert.match(missing.stdout, /ENOENT/);
    const system = await containedTerminal({ argv: [process.execPath, script, "/etc/passwd", dst], worktree, home, ...mountOptions(worktree), timeoutMs: 15_000 });
    assert.equal(system.ok, true, JSON.stringify(system));
    if (system.ok) assert.match(system.stdout, /EXDEV/);
  } else {
    const created = await containedTerminal({ argv: [process.execPath, script, outside, dst], worktree, home, ...mountOptions(worktree), timeoutMs: 15_000 });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (created.ok) assert.match(created.stdout, /EPERM/);
    const device = join(worktree, "dev");
    const dev = await containedTerminal({ argv: [process.execPath, script, "/dev/null", device], worktree, home, ...mountOptions(worktree), timeoutMs: 15_000 });
    assert.equal(dev.ok, true, JSON.stringify(dev));
    if (dev.ok) assert.match(dev.stdout, /EPERM|EXDEV|EINVAL/);
    assert.equal(existsSync(device), false);
  }
  assert.equal(existsSync(dst), false);
  assert.equal(readFileSync(outside, "utf8"), "safe");
});

test("terminal cannot write hooks or retarget core.hooksPath", async () => {
  if (process.platform === "win32") {
    const refused = await containedTerminal({ argv: ["/usr/bin/true"], worktree: "/tmp", home: "/tmp", platform: "win32" });
    assert.deepEqual(refused, { ok: false, reason: "sandbox-unavailable" });
    return;
  }
  const root = tempDir("m6b-red-git-");
  const { repo, worktree, home } = gitWorktree(root);
  const touch = "/usr/bin/touch";
  const git = "/usr/bin/git";
  const hook = join(repo, ".git", "hooks", "pre-commit");
  const denied = await containedTerminal({ argv: [touch, hook], worktree, home, ...mountOptions(worktree), timeoutMs: 15_000 });
  assert.equal(existsSync(hook), false);
  if (denied.ok) assert.notEqual(denied.exitCode, 0);
  const cfg = await containedTerminal({ argv: [git, "-C", repo, "config", "core.hooksPath", "/tmp/evil"], worktree, home, ...mountOptions(worktree), timeoutMs: 15_000 });
  if (cfg.ok) assert.notEqual(cfg.exitCode, 0, cfg.stderr);
  let hooks = "";
  try { hooks = execFileSync("git", ["-C", repo, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(); } catch { hooks = ""; }
  assert.equal(hooks.includes("/tmp/evil"), false);
  assert.ok(gitDenyPaths(worktree).some((p) => p.includes("hooks") || p.includes(".git")));
});
