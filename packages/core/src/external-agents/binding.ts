// Repo binding checks for a root project (subprojects spec §6.1, without the M5+ remote and identity fields).
import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import { CollabError } from "../collab/errors.ts";
import { git, type GitExec } from "./git.ts";

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function real(p: string): string {
  return realpathSync(p);
}

function inside(child: string, parent: string): boolean {
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(base);
}

/** `git rev-parse --show-toplevel` must be `repoPath`. Bare repos and anything under the harness home are refused. */
export function assertRepoBinding(repoPath: string, baseBranch: string, home: string, exec: GitExec = { run: git }): { repoPath: string; baseBranch: string } {
  if (!repoPath || !baseBranch) throw new CollabError("invalid", "repoPath and baseBranch are required", { reason: "repo-binding" });
  if (!BRANCH.test(baseBranch) || baseBranch.split("/").some((s) => s === ".." || s === "." || s.startsWith("-"))) {
    throw new CollabError("invalid", "baseBranch is not a safe branch name", { reason: "base-branch" });
  }
  let repo: string;
  let harness: string;
  try {
    repo = real(repoPath);
    harness = real(home);
  } catch {
    throw new CollabError("invalid", "repo path or harness home does not exist", { reason: "repo-path" });
  }
  if (inside(repo, harness)) throw new CollabError("invalid", "a repository under the harness home is refused", { reason: "home-path" });
  let dir: ReturnType<typeof statSync>;
  try { dir = statSync(repo); } catch {
    throw new CollabError("invalid", "repo path is not a directory", { reason: "repo-path" });
  }
  if (!dir.isDirectory()) throw new CollabError("invalid", "repo path is not a directory", { reason: "repo-path" });
  const bare = exec.run(["rev-parse", "--is-bare-repository"], repo).trim();
  if (bare === "true") throw new CollabError("invalid", "a bare repository cannot be bound", { reason: "bare-repo" });
  let top: string;
  try { top = real(exec.run(["rev-parse", "--show-toplevel"], repo).trim()); }
  catch { throw new CollabError("invalid", "git rev-parse --show-toplevel failed", { reason: "not-a-repo" }); }
  if (top !== repo) throw new CollabError("invalid", "git rev-parse --show-toplevel does not equal repoPath", { reason: "toplevel-mismatch" });
  try { exec.run(["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}`], repo); }
  catch { throw new CollabError("invalid", `base branch ${baseBranch} does not exist`, { reason: "base-branch" }); }
  return { repoPath: repo, baseBranch };
}
