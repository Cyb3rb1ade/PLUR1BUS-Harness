// The one git worktree implementation (subprojects spec §6.5). M5+ adds merge and revert here.
import { createHash } from "node:crypto";
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
    let branch = cardId ? cardBranch(key, assertId(cardId)) : rootBranch(key);
    let path = cardId
      ? join(this.#stateDir, "worktrees", rootId, "cards", `c-${hex6(cardId)}`)
      : join(this.#stateDir, "worktrees", rootId, rootId);
    if (path.startsWith(project.repo.repoPath + sep) || path === project.repo.repoPath) {
      throw new CollabError("invalid", "worktree path must stay outside the repository", { reason: "worktree-inside-repo" });
    }
    const parent = cardId
      ? (this.#store.liveWorktree(project.id, null)?.branch ?? project.repo.baseBranch)
      : project.repo.baseBranch;
    const common = realpathSync(this.#exec.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], project.repo.repoPath).trim());
    const exists = (name: string): boolean => {
      try { this.#exec.run(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], project.repo!.repoPath); return true; }
      catch (error) { if ((error as { status?: number }).status === 1) return false; throw error; }
    };
    const previous = this.#store.previousWorktree(project.id, cardId);
    const retained = previous?.commonGitDir === common && exists(previous.branch);
    if (retained) {
      // Only our DB-pinned branch in the same repository may be reattached. No reset/delete/force.
      branch = previous.branch;
      // Keep retained work, but always reattach in the current sibling layout (including old DB rows).
      if (cardId) {
        const suffix = /\/c-([a-f0-9]{6})$/.exec(branch)?.[1];
        if (!suffix) throw new CollabError("conflict", "retained card branch is invalid", { reason: "worktree-unsafe" });
        path = join(this.#stateDir, "worktrees", rootId, "cards", `c-${suffix}`);
      }
    } else {
      // Abbreviated IDs can collide. Preserve unrelated/retained branches and choose a stable alternative.
      const original = branch;
      let attempt = 0;
      while (exists(branch)) {
        if (++attempt > 128) throw new CollabError("conflict", "worktree name space exhausted", { reason: "worktree-name" });
        const suffix = createHash("sha256").update(`${project.id}:${cardId ?? "root"}:${attempt}`).digest("hex").slice(0, 6);
        branch = cardId ? `p1b/${key}/c-${suffix}` : `${original}-g${suffix}`;
        if (cardId) path = join(this.#stateDir, "worktrees", rootId, "cards", `c-${suffix}`);
      }
    }
    const baseSha = this.#exec.run(["rev-parse", retained ? branch : parent], project.repo.repoPath).trim();
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.#exec.run(retained ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, parent], project.repo.repoPath);
    } catch {
      throw new CollabError("conflict", "worktree could not be safely attached; existing branches and paths were preserved", { reason: "worktree-unsafe" });
    }
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
