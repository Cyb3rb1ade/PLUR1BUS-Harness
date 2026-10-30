import { provisionFixture, mountOptions } from "./fixture.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ContainmentError, containedRead, containedTerminal, containedWrite, gitDenyPaths } from "../../src/external-agents/containment.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function gitWorktree(root: string): { repo: string; worktree: string; home: string } {
  const home = join(root, "home");
  const repo = join(root, "repo");
  let worktree: string;
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
  worktree = provisionFixture(home, repo);
  return { repo, worktree, home };
}

const reason = (e: unknown) => e instanceof ContainmentError && e.reason;

test("filesystem writes stay in the worktree", async () => {
  const root = tempDir("m6b-fs-");
  const { worktree, home } = gitWorktree(root);
  const box = { worktree, home };
  await containedWrite(box, join(worktree, "ok.txt"), "hello");
  assert.equal(await containedRead(box, join(worktree, "ok.txt")), "hello");
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(worktree, "link"));
  await assert.rejects(containedWrite(box, join(worktree, "link"), "x"), (e) => reason(e) === "outside-root" || reason(e) === "deny-listed");
  await assert.rejects(containedWrite(box, join(worktree, "..", "outside.txt"), "x"), (e) => typeof reason(e) === "string");
  await assert.rejects(containedWrite(box, outside, "x"), (e) => reason(e) === "outside-root" || reason(e) === "deny-listed");
  await assert.rejects(containedWrite(box, join(home, "notes.txt"), "x"), (e) => reason(e) === "deny-listed" || reason(e) === "outside-root");
  const target = join(root, "hard-target.txt");
  writeFileSync(target, "a");
  try { linkSync(target, join(worktree, "hard")); } catch { return; }
  await assert.rejects(containedWrite(box, join(worktree, "hard"), "b"), (e) => reason(e) === "hard-link");
});

test("a worktree under the harness home stays writable and the rest of home does not", async () => {
  const root = tempDir("m6b-fs-home-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  const worktree = join(home, "state", "worktrees", "prj", "prj");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", "p1b/demo-abcdef/main", worktree, "main"], { stdio: "pipe" });
  const box = { worktree, home };
  await containedWrite(box, "inside.txt", "yes");
  assert.equal(await containedRead(box, "inside.txt"), "yes");
  await assert.rejects(containedWrite(box, join(home, "secret.txt"), "no"), (e) => typeof reason(e) === "string");
  assert.equal(existsSync(join(home, "secret.txt")), false);
});

test("windows name rules refuse 8.3 and device names through the same canonicaliser", async () => {
  const root = tempDir("m6b-win-");
  const { worktree, home } = gitWorktree(root);
  const box = { worktree, home, ...mountOptions(worktree), windowsRules: true };
  await assert.rejects(containedWrite(box, join(worktree, "CON"), "x"), (e) => typeof reason(e) === "string");
  await assert.rejects(containedWrite(box, join(worktree, "NOTES~1.TXT"), "x"), (e) => typeof reason(e) === "string");
  await assert.rejects(() => containedRead(box, join(worktree, "ok.txt:secret")), (e) => typeof reason(e) === "string");
});

test("terminal callbacks are refused on Windows and cannot write the shared gitdir", async () => {
  const refused = await containedTerminal({ argv: ["/bin/true"], worktree: "/tmp", home: "/tmp", platform: "win32" });
  assert.deepEqual(refused, { ok: false, reason: "sandbox-unavailable" });
  if (process.platform === "win32") return;
  const root = tempDir("m6b-term-");
  const { repo, worktree, home } = gitWorktree(root);
  const touch = process.platform === "darwin" ? "/usr/bin/touch" : "/usr/bin/touch";
  const inside = await containedTerminal({ argv: [touch, join(worktree, "from-terminal.txt")], worktree, home, ...mountOptions(worktree) });
  assert.equal(inside.ok, true, JSON.stringify(inside));
  if (inside.ok) assert.equal(inside.exitCode, 0, inside.stderr);
  assert.equal(existsSync(join(worktree, "from-terminal.txt")), true);
  const hook = join(repo, ".git", "hooks", "pre-commit");
  const denied = await containedTerminal({ argv: [touch, hook], worktree, home, ...mountOptions(worktree) });
  assert.equal(existsSync(hook), false);
  if (denied.ok) assert.notEqual(denied.exitCode, 0);
  const git = process.platform === "darwin" ? "/usr/bin/git" : "/usr/bin/git";
  const cfg = await containedTerminal({ argv: [git, "-C", repo, "config", "core.hooksPath", "/tmp/evil"], worktree, home, ...mountOptions(worktree) });
  if (cfg.ok) assert.notEqual(cfg.exitCode, 0, cfg.stderr);
  let hooks = "";
  try { hooks = execFileSync("git", ["-C", repo, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(); } catch { hooks = ""; }
  assert.equal(hooks.includes("/tmp/evil"), false);
  assert.ok(gitDenyPaths(worktree).some((p) => p.endsWith("/hooks") || p.endsWith("\\hooks") || p.includes(".git")));
});
