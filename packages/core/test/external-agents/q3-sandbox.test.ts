/** Q3 opt-in, metadata and real sandbox regressions. No unavailable-backend skips. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { test } from "node:test";
import { backendArgv } from "../../src/tools/sandbox/backends.ts";
import { preparePolicy } from "../../src/tools/sandbox/policy.ts";
import { containedTerminal, containedWrite } from "../../src/external-agents/containment.ts";
import { pinnedGit } from "../../src/external-agents/git.ts";
import { provisionFixture, mountOptions } from "./fixture.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function fixture() {
  const root = tempDir("q3-sandbox-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main");
  git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "init");
  const worktree = provisionFixture(home, repo);
  const options = { home, worktree, ...mountOptions(worktree) };
  const policy = { home, userHome: homedir(), cwd: worktree, readRoots: [{ id: "wt", path: worktree }],
    writeRoots: [{ id: "wt", path: worktree }], network: "none" as const, envAllow: [],
    acpWorktree: options.mount, limitsHelper: options.limitsHelper,
    limits: { timeoutMs: 10000, cpuSeconds: 10, memoryBytes: 2 ** 30, maxOutputBytes: 65536, maxTasks: 32 } };
  return { root, repo, git, worktree, options, policy };
}

test("the ACP opt-in rejects forged, multiple, mismatched, symlinked and hard-linked roots", async () => {
  const f = fixture();
  await assert.rejects(preparePolicy({ ...f.policy, acpWorktree: {} as never }), /forged/);
  await assert.rejects(preparePolicy({ ...f.policy, writeRoots: [...f.policy.writeRoots, ...f.policy.writeRoots] }), /mismatched/);
  await assert.rejects(preparePolicy({ ...f.policy, writeRoots: [{ id: "wrong", path: f.root }] }), /mismatched/);
  writeFileSync(join(f.root, "outside"), "secret");
  linkSync(join(f.root, "outside"), join(f.worktree, "alias"));
  await assert.rejects(preparePolicy(f.policy), /hard-linked/);
  unlinkSync(join(f.worktree, "alias"));
  const moved = f.worktree + "-moved";
  renameSync(f.worktree, moved);
  symlinkSync(moved, f.worktree);
  await assert.rejects(preparePolicy(f.policy), /symlinked|identity changed/);
  unlinkSync(f.worktree);
  renameSync(moved, f.worktree);
  const parent = dirname(f.worktree), movedParent = parent + "-moved";
  renameSync(parent, movedParent);
  symlinkSync(movedParent, parent);
  await assert.rejects(preparePolicy(f.policy), /symlinked/);
  unlinkSync(parent);
  renameSync(movedParent, parent);
});

test("ordinary backend callers retain writable-root refusal and approved Git dirs are mounted read-only", async () => {
  const f = fixture();
  const p = await preparePolicy(f.policy);
  const detection = { backend: "bubblewrap" as const, strength: "partial" as const, available: true,
    reason: "fixture", tasks: { mechanism: "namespace-limit" as const, reason: "fixture" } };
  const ordinary = { ...p };
  delete ordinary.acpWorktree;
  await assert.rejects(backendArgv(ordinary, detection, ["/usr/bin/true"]), /writable roots/);
  const argv = await backendArgv(p, detection, ["/usr/bin/true"]);
  assert.equal(argv.filter(v => v === "--bind").length, 1);
  assert.ok(argv.includes("--cap-drop"));
  const gitDir = execFileSync("git", ["-C", f.worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  for (const path of [gitDir, join(f.repo, ".git")])
    assert.ok(argv.some((v, i) => v === "--ro-bind" && argv[i + 1] === path && argv[i + 2] === path));
});

test("host Git ignores a replaced .git pointer and never executes a clean filter", () => {
  const f = fixture();
  const gitDir = execFileSync("git", ["-C", f.worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  const marker = join(f.root, "executed");
  f.git("config", "filter.evil.clean", `touch ${marker}`);
  writeFileSync(join(f.worktree, ".gitattributes"), "*.txt filter=evil\n");
  writeFileSync(join(f.worktree, "file.txt"), "safe");
  pinnedGit(gitDir, f.worktree, ["add", "file.txt", ".gitattributes"]);
  writeFileSync(join(f.worktree, "file.txt"), "changed tracked file");
  writeFileSync(join(f.worktree, ".git"), "gitdir: /nonexistent-attacker-metadata\n");
  assert.match(pinnedGit(gitDir, f.worktree, ["status", "--porcelain"]), /file.txt/);
  pinnedGit(gitDir, f.worktree, ["diff", "HEAD"]);
  assert.equal(existsSync(marker), false);
});

test("terminals see an isolated HOME, deny Harness state and run real Git commands", async () => {
  if (process.platform === "win32") {
    assert.deepEqual(await containedTerminal({ argv: ["cmd.exe"], home: "/missing", worktree: "/missing" }), { ok: false, reason: "sandbox-unavailable" });
    return;
  }
  const f = fixture();
  writeFileSync(join(f.options.home, "config.json"), "HARNESS-SECRET");
  writeFileSync(join(f.worktree, "auth.json"), "CREDENTIAL-CANARY");
  const marker = join(f.worktree, "probe.cjs");
  writeFileSync(marker, `const fs=require('fs'); console.log(process.env.HOME); console.log(fs.readdirSync(process.env.HOME));
try { console.log(fs.readFileSync(${JSON.stringify(join(f.options.home, "config.json"))},'utf8')); } catch { console.log('denied'); }
try { console.log(fs.readFileSync('auth.json','utf8')); } catch { console.log('credentials-denied'); }
try { fs.readdirSync(${JSON.stringify(homedir())}); console.log('real-home-visible'); } catch { console.log('real-home-denied'); }
fs.writeFileSync('build-output','ok');`);
  assert.deepEqual(await containedTerminal({ ...f.options, argv: [process.execPath, marker], maxTasks: 0 }), { ok: false, reason: "sandbox-unavailable" });
  const result = await containedTerminal({ ...f.options, argv: [process.execPath, marker] });
  assert.equal(result.ok && result.exitCode, 0, JSON.stringify(result));
  if (result.ok) { assert.doesNotMatch(result.stdout, /HARNESS-SECRET|CREDENTIAL-CANARY|real-home-visible/); assert.match(result.stdout, /real-home-denied/); assert.match(result.stdout, /denied/); }
  assert.equal(readFileSync(join(f.worktree, "build-output"), "utf8"), "ok");
  for (const args of [["status", "--porcelain"], ["diff", "HEAD"]]) {
    const git = await containedTerminal({ ...f.options, argv: ["git", ...args] });
    assert.equal(git.ok && git.exitCode, 0, JSON.stringify(git));
  }
  await assert.rejects(containedWrite(f.options, join(f.worktree, "..", "sibling"), "x"));
});

test("macOS open and osascript cannot escape the shared Seatbelt profile", async () => {
  if (process.platform !== "darwin") return;
  const f = fixture();
  for (const argv of [["/usr/bin/open", "-a", "Terminal"], ["/usr/bin/osascript", "-e", 'tell application "Finder" to get name']]) {
    const result = await containedTerminal({ ...f.options, argv });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.notEqual(result.exitCode, 0);
  }
});
