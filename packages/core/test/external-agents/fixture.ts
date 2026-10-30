/** Real provisioned worktrees and native helper used by the ACP containment acceptance tests. */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { CollabStore } from "../../src/collab/store.ts";
import { GitWorktreeProvisioner } from "../../src/external-agents/provisioner.ts";
import { AcpWorktreeMount } from "../../src/tools/sandbox/acp-worktree.ts";
export const limitsHelper = join(process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../../../../target", import.meta.url)), "debug", "plur1bus-sandbox-limits");
const stores = new Map<string, { store: CollabStore; projectId: string; home: string }>();
after(() => { for (const { store } of stores.values()) store.close(); stores.clear(); });

/** Provision through production code; grants cannot be forged by a wire client or arbitrary cwd. */
export function provisionFixture(home: string, repo: string): string {
  mkdirSync(join(home, "state"), { recursive: true });
  const canonicalHome = realpathSync(home);
  const state = join(canonicalHome, "state");
  const store = new CollabStore({ path: join(state, "collab.sqlite") });
  const project = store.createProject({ owner: "owner", name: "Fixture" });
  store.setRepo(project.id, { repoPath: repo, baseBranch: "main" });
  const tree = new GitWorktreeProvisioner(store, state).fork({ projectId: project.id });
  stores.set(tree.path, { store, projectId: project.id, home: canonicalHome });
  return tree.path;
}

export function mountOptions(worktree: string) {
  const record = stores.get(worktree);
  if (!record) throw new Error("fixture was not provisioned");
  return { mount: AcpWorktreeMount.fromStore(record.store, join(record.home, "state"), record.projectId, null), limitsHelper };
}
