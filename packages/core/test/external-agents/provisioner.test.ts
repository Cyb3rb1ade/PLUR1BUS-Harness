import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { CollabError } from "../../src/collab/errors.ts";
import { createCollab } from "../../src/collab/service.ts";
import { CollabStore } from "../../src/collab/store.ts";
import { gitArgv, realGit, type GitExec } from "../../src/external-agents/git.ts";
import { cardBranch, projectKey, rootBranch } from "../../src/external-agents/names.ts";
import { GitWorktreeProvisioner, provisionedWorktreePort } from "../../src/external-agents/provisioner.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { owner } from "../collab/helpers.ts";

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-b", "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
}

test("fork names the branch and worktree, remove keeps the branch, and argv stays hardened", () => {
  const root = tempDir("m6b-wt-");
  const home = join(root, "home");
  mkdirSync(join(root, "repo"), { recursive: true });
  const repo = realpathSync(join(root, "repo"));
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  gitInit(repo);
  const calls: string[][] = [];
  const git: GitExec = { run(args, cwd) { calls.push(["git", ...gitArgv(args, cwd)]); return realGit.run(args, cwd); } };
  const db = join(state, "collab.sqlite");
  const lead = owner();
  const collab = createCollab({ path: db, home, git });
  const project = collab.createProject(lead, { name: "Auth Rework" });
  collab.bindRepo(lead, project.id, repo, "main");
  const id = project.id;
  collab.close();
  const store = new CollabStore({ path: db });
  try {
    const provisioner = new GitWorktreeProvisioner(store, state, git);
    const forked = provisioner.fork({ projectId: id });
    const key = projectKey("Auth Rework", id);
    assert.equal(forked.branch, rootBranch(key));
    assert.equal(forked.path, realpathSync(join(state, "worktrees", id, id)));
    assert.equal(forked.path.startsWith(repo + sep), false);
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", forked.branch], { encoding: "utf8" }).trim(), forked.branch);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();
    assert.equal(forked.baseSha, head);
    const card = provisioner.fork({ projectId: id, cardId: "crd_aabbcc" });
    assert.equal(card.branch, cardBranch(key, "crd_aabbcc"));
    assert.equal(provisionedWorktreePort(store, () => "/workspace").root("agent", id, "crd_aabbcc"), card.path);
    assert.equal(provisionedWorktreePort(store, () => "/workspace").root("agent", id, "missing"), forked.path);
    const flat = calls.flat();
    assert.ok(flat.includes("core.hooksPath=/dev/null"));
    assert.equal(flat.includes("--force"), false);
    assert.equal(flat.some((a) => a === "reset" || a === "rebase" || a === "push" || a === "sh" || a === "bash"), false);
    assert.ok(calls.every((c) => c[0] === "git"));
    const again = createCollab({ path: db, home, git });
    try {
      assert.throws(() => again.unbindRepo(lead, id), (e: unknown) => e instanceof CollabError && e.reason === "worktree-live");
    } finally { again.close(); }
    provisioner.remove({ projectId: id, cardId: "crd_aabbcc" });
    provisioner.remove({ projectId: id });
    assert.equal(existsSync(forked.path), false);
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "--verify", forked.branch], { encoding: "utf8" }).trim().length > 0, true);
    assert.equal(provisioner.status({ projectId: id }), null);
    const loose = store.createProject({ name: "Loose", owner: "u-owner" });
    assert.equal(provisionedWorktreePort(store, () => "/workspace").root("a", loose.id, "c"), "/workspace");
  } finally { store.close(); }
});
