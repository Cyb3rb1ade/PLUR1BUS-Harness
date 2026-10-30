// The one git worktree implementation (subprojects spec §6.5). M5+ adds merge and revert here.
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { ProjectWorktreePort, ProjectWorktreeProvisioner } from "../collab/coding-surface.ts";
import { CollabError } from "../collab/errors.ts";
import type { CollabStore } from "../collab/store.ts";
import { git, type GitExec } from "./git.ts";
import { assertId, cardBranch, hex6, projectKey, rootBranch } from "./names.ts";

const FORBIDDEN = new Set(["--force", "reset", "rebase", "push"]);

export class GitWorktreeProvisioner implements ProjectWorktreeProvisioner {
  readonly #store: CollabStore;
  readonly #stateDir: string;
  readonly #exec: GitExec;
  constructor(store: CollabStore, stateDir: string, exec: GitExec = { run: git }) {
    this.#store = store;
    this.#stateDir = stateDir;
    this.#exec = exec;
  }

  fork(input: { projectId: string; cardId?: string }): { baseSha: string; branch: string; path: string } {
    const project = this.#store.getProject(input.projectId);
    if (!project) throw new CollabError("not-found", "project not found", { reason: "project" });
    if (!project.repo) throw new CollabError("conflict", "the project has no repository binding", { reason: "repo-unbound" });
    const cardId = input.cardId ?? null;
    if (this.#store.liveWorktree(project.id, cardId)) throw new CollabError("conflict", "worktree already exists", { reason: "worktree-exists" });
    const rootId = assertId(project.id);
    const key = projectKey(project.name, project.id);
    const branch = cardId ? cardBranch(key, assertId(cardId)) : rootBranch(key);
    const path = cardId
      ? join(this.#stateDir, "worktrees", rootId, "cards", `c-${hex6(cardId)}`)
      : join(this.#stateDir, "worktrees", rootId, rootId);
    if (path.startsWith(project.repo.repoPath + sep) || path === project.repo.repoPath) {
      throw new CollabError("invalid", "worktree path must stay outside the repository", { reason: "worktree-inside-repo" });
    }
    const parent = cardId
      ? (this.#store.liveWorktree(project.id, null)?.branch ?? project.repo.baseBranch)
      : project.repo.baseBranch;
    const baseSha = this.#exec.run(["rev-parse", parent], project.repo.repoPath).trim();
    mkdirSync(dirname(path), { recursive: true });
    this.#exec.run(["worktree", "add", "-b", branch, path, parent], project.repo.repoPath);
    const gitDir = realpathSync(this.#exec.run(["rev-parse", "--absolute-git-dir"], path).trim());
    const commonGitDir = realpathSync(this.#exec.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], path).trim());
    const identity = statSync(path);
    this.#store.insertWorktree({ projectId: project.id, rootId, cardId, branch, path: realpathSync(path), baseSha, gitDir, commonGitDir, dev: String(identity.dev), ino: String(identity.ino) });
    return { baseSha, branch, path: realpathSync(path) };
  }

  remove(input: { projectId: string; cardId?: string }): void {
    const project = this.#store.getProject(input.projectId);
    if (!project?.repo) throw new CollabError("conflict", "the project has no repository binding", { reason: "repo-unbound" });
    const row = this.#store.liveWorktree(input.projectId, input.cardId ?? null);
    if (!row) throw new CollabError("not-found", "no live worktree", { reason: "worktree" });
    this.#exec.run(["worktree", "remove", row.path], project.repo.repoPath);
    this.#store.markWorktreeRemoved(input.projectId, input.cardId ?? null);
  }

  status(input: { projectId: string; cardId?: string }): { branch: string; path: string; baseSha: string; removed: boolean } | null {
    const row = this.#store.liveWorktree(input.projectId, input.cardId ?? null);
    return row ? { branch: row.branch, path: row.path, baseSha: row.baseSha, removed: false } : null;
  }
}

/** Bound projects use the provisioned checkout. Without a binding, the previous workspace fallback stays. */
export function provisionedWorktreePort(store: CollabStore, fallback: (agentId: string) => string | null, stateDir?: string): ProjectWorktreePort {
  return { root(_agentId, projectId, cardId) {
    const project = store.getProject(projectId);
    if (!project?.repo) return fallback(_agentId);
    if (stateDir) {
      const provisioner = new GitWorktreeProvisioner(store, stateDir);
      if (!store.liveWorktree(projectId, null)) provisioner.fork({ projectId });
      if (cardId && !store.liveWorktree(projectId, cardId)) provisioner.fork({ projectId, cardId });
    }
    return store.liveWorktree(projectId, cardId || null)?.path ?? null;
  } };
}

export function assertGitArgv(argv: readonly string[]): void {
  if (argv[0] !== "git") throw new Error("git must be exec'd directly");
  for (const a of argv) if (FORBIDDEN.has(a) || a === "sh" || a === "bash") throw new Error(`forbidden git argv ${a}`);
}
