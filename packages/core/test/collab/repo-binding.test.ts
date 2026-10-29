import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CollabError } from "../../src/collab/errors.ts";
import { createCollab } from "../../src/collab/service.ts";
import { gitArgv, realGit, type GitExec } from "../../src/external-agents/git.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { member, owner } from "./helpers.ts";

function gitInit(dir: string, branch = "main"): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-b", branch);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
}

function recorded(): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    git: {
      run(args, cwd) {
        calls.push(["git", ...gitArgv(args, cwd)]);
        return realGit.run(args, cwd);
      },
    },
  };
}

const lead = owner();

test("bind records toplevel and base branch; unbind clears it; only a lead person may call", () => {
  const root = tempDir("m6b-bind-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(home, "state"), { recursive: true });
  gitInit(repo);
  const rec = recorded();
  const collab = createCollab({ path: join(home, "state", "collab.sqlite"), home, git: rec.git });
  try {
    const project = collab.createProject(lead, { name: "Auth rework" });
    const bound = collab.bindRepo(lead, project.id, repo, "main");
    assert.equal(bound.repo?.repoPath, realpathSync(repo));
    assert.equal(bound.repo?.baseBranch, "main");
    assert.equal(collab.getProject(lead, project.id).repo?.baseBranch, "main");
    const flat = rec.calls.flat();
    assert.ok(flat.includes("core.hooksPath=/dev/null"));
    assert.equal(flat.includes("--force"), false);
    assert.equal(flat.some((a) => a === "reset" || a === "rebase" || a === "push"), false);
    assert.ok(rec.calls.every((c) => c[0] === "git"));
    const cleared = collab.unbindRepo(lead, project.id);
    assert.equal(cleared.repo, undefined);
  } finally { collab.close(); }
});

test("bind refuses a member, an agent, a bare repo, a path under home, a missing branch and a nested path", () => {
  const root = tempDir("m6b-bind-no-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  const bare = join(root, "bare.git");
  const nestedHome = join(home, "secret-repo");
  mkdirSync(home);
  gitInit(repo);
  mkdirSync(join(repo, "sub"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
  gitInit(nestedHome);
  const collab = createCollab({ path: ":memory:", home, git: realGit });
  try {
    const project = collab.createProject(lead, { name: "P" });
    collab.addMember(lead, project.id, "u-member", "member");
    const person = member();
    assert.throws(() => collab.bindRepo(person, project.id, repo, "main"), (e: unknown) => e instanceof CollabError && e.reason === "lead-required");
    assert.throws(() => collab.bindRepo({ ...lead, kind: "agent" }, project.id, repo, "main"), (e: unknown) => e instanceof CollabError && e.reason === "agent-principal");
    assert.throws(() => collab.bindRepo(lead, project.id, bare, "main"), (e: unknown) => e instanceof CollabError && e.reason === "bare-repo");
    assert.throws(() => collab.bindRepo(lead, project.id, nestedHome, "main"), (e: unknown) => e instanceof CollabError && e.reason === "home-path");
    assert.throws(() => collab.bindRepo(lead, project.id, repo, "nope"), (e: unknown) => e instanceof CollabError && e.reason === "base-branch");
    assert.throws(() => collab.bindRepo(lead, project.id, join(repo, "sub"), "main"), (e: unknown) => e instanceof CollabError && e.reason === "toplevel-mismatch");
  } finally { collab.close(); }
});
