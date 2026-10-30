import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { CollabError } from "../../src/collab/errors.ts";
import { createCollab } from "../../src/collab/service.ts";
import { CollabStore } from "../../src/collab/store.ts";
import { gitArgv, gitEnv, hostGitExecutable, windowsGitCandidates, realGit, type GitExec } from "../../src/external-agents/git.ts";
import { cardBranch, projectKey, rootBranch, hex6 } from "../../src/external-agents/names.ts";
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
    assert.equal(card.path.startsWith(forked.path + sep), false);
    assert.equal(card.path, realpathSync(join(state, "worktrees", id, "cards", `c-${hex6("crd_aabbcc")}`)));
    assert.equal(card.branch, cardBranch(key, "crd_aabbcc"));
    assert.equal(provisionedWorktreePort(store, () => "/workspace").root("agent", id, "crd_aabbcc"), card.path);
    assert.equal(provisionedWorktreePort(store, () => "/workspace").root("agent", id, "missing"), null);
    const flat = calls.flat();
    assert.ok(flat.includes("core.hooksPath=/dev/null"));
    assert.equal(flat.includes("--force"), false);
    assert.equal(flat.some((a) => a === "reset" || a === "rebase" || a === "push" || a === "sh" || a === "bash"), false);
    assert.ok(calls.every((c) => c[0] === "git"));
    const again = createCollab({ path: db, home, git });
    try {
      assert.throws(() => again.bindRepo(lead, id, repo, "main"), (e: unknown) => e instanceof CollabError && e.reason === "worktree-live");
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


test("normal card IDs exclude their prefix, collisions stay distinct and retained branches reprovision", () => {
  const temp = tempDir("q3-reprovision-");
  const home = join(temp, "home");
  const state = join(home, "state"), repo = join(temp, "repo");
  mkdirSync(state, { recursive: true }); gitInit(repo);
  const store = new CollabStore({ path: join(state, "collab.sqlite") });
  const project = store.createProject({ owner: "u-owner", name: "Lifecycle" });
  store.setRepo(project.id, { repoPath: repo, baseBranch: "main" });
  const provisioner = new GitWorktreeProvisioner(store, state);
  try {
    const root = provisioner.fork({ projectId: project.id });
    const ids = ["card_12300000-0000-4000-8000-000000000001", "card_123fffff-ffff-4fff-8fff-ffffffffffff",
      "card_abcdef00-0000-4000-8000-000000000001", "card_abcdef11-0000-4000-8000-000000000002"];
    const cards = ids.map(cardId => provisioner.fork({ projectId: project.id, cardId }));
    assert.equal(cards[0]!.path.endsWith("cards/c-123000"), true);
    assert.equal(cards[1]!.path.endsWith("cards/c-123fff"), true);
    assert.equal(new Set(cards.map(c => c.path)).size, 4);
    assert.equal(new Set(cards.map(c => c.branch)).size, 4);
    for (const cardId of ids) provisioner.remove({ projectId: project.id, cardId });
    const cardAgain = provisioner.fork({ projectId: project.id, cardId: ids[3]! });
    assert.equal(cardAgain.path, cards[3]!.path);
    assert.equal(cardAgain.branch, cards[3]!.branch);
    provisioner.remove({ projectId: project.id, cardId: ids[3]! });
    const elsewhere = join(temp, "elsewhere");
    execFileSync("git", ["-C", repo, "worktree", "add", elsewhere, cards[3]!.branch]);
    assert.throws(() => provisioner.fork({ projectId: project.id, cardId: ids[3]! }),
      (e: unknown) => e instanceof CollabError && e.reason === "worktree-unsafe");
    execFileSync("git", ["-C", repo, "worktree", "remove", elsewhere]);
    writeFileSync(join(root.path, "preserved.txt"), "retained work");
    execFileSync("git", ["-C", root.path, "add", "preserved.txt"]);
    execFileSync("git", ["-C", root.path, "commit", "-m", "retained work"]);
    const head = execFileSync("git", ["-C", root.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    provisioner.remove({ projectId: project.id });
    const again = provisioner.fork({ projectId: project.id });
    assert.equal(again.branch, root.branch);
    assert.equal(again.baseSha, head);
    provisioner.remove({ projectId: project.id });
    const collab = createCollab({ path: join(state, "collab.sqlite"), home, provisionWorktrees: true });
    try {
      collab.unbindRepo(owner(), project.id);
      collab.bindRepo(owner(), project.id, repo, "main");
      assert.equal(store.liveWorktree(project.id, null)!.branch, root.branch);
      assert.equal(store.liveWorktree(project.id, null)!.baseSha, head);
    } finally { collab.close(); }
  } finally { store.close(); }
});


test("host Git selects Git for Windows using the trusted host PATH, with inherited Git config suppressed", () => {
  assert.deepEqual(windowsGitCandidates('relative;.;"C:\\Program Files\\Git\\cmd";;D:\\Tools'),
    ["C:\\Program Files\\Git\\cmd\\git.exe", "D:\\Tools\\git.exe"]);
  if (process.platform !== "win32") assert.equal(hostGitExecutable(), "/usr/bin/git");
  assert.equal(gitEnv().PATH, process.env.PATH ?? "/usr/bin:/bin");
  assert.equal(gitEnv().GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(gitEnv().GIT_CONFIG_COUNT, undefined);
});
