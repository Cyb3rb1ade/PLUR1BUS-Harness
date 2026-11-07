/** Trusted B1 seed authoring and the shared #820 card-worktree API, before any model gains access. */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { gitText } from "../collab/verifier.ts";
import { createCollab, type Collab } from "../collab/service.ts";
import { CollabStore } from "../collab/store.ts";

type BoundCollab = Collab & {
  bindRepo(
    person: { userId: string; kind: "person"; role: "owner" },
    projectId: string,
    path: string,
    branch: string,
  ): unknown;
};
interface SharedProvisioner {
  fork(input: { projectId: string; cardId?: string }): { path: string };
}

try {
  const value: unknown = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid seed request");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !== "agent,home,owner,repository" ||
    ![row.repository, row.home, row.owner, row.agent].every((value) => typeof value === "string") ||
    !isAbsolute(row.repository as string) ||
    !isAbsolute(row.home as string) ||
    dirname(row.repository as string) !== dirname(row.home as string)
  )
    throw new Error("invalid seed request");
  // This API deliberately does not exist before #820. No substitute worktree implementation is provided.
  const moduleUrl = new URL("../external-agents/provisioner.ts", import.meta.url).href;
  const api = (await import(moduleUrl)) as Record<string, unknown>;
  if (typeof api.GitWorktreeProvisioner !== "function") throw new Error("shared provisioner unavailable");
  const Provisioner = api.GitWorktreeProvisioner as new (store: CollabStore, state: string) => SharedProvisioner;
  const git = (args: string[]) =>
    gitText(row.repository as string, [
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ]);
  git(["init", "--quiet", "--initial-branch=bench"]);
  git(["add", "--all"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "Original seeded B1 starting state"]);
  const home = row.home as string;
  const state = join(home, "state");
  const database = join(state, "collab.sqlite");
  const person = { userId: row.owner as string, kind: "person" as const, role: "owner" as const };
  const settings = { path: database, home };
  const collab = createCollab(settings) as BoundCollab;
  let projectId: string;
  let cardId: string;
  try {
    if (typeof collab.bindRepo !== "function") throw new Error("shared binding unavailable");
    const project = collab.createProject(person, { name: "B1 coding task" });
    projectId = project.id;
    collab.bindRepo(person, projectId, row.repository as string, "bench");
    collab.addAgent(person, projectId, row.agent as string);
    const card = collab.boardStore.createCard(
      projectId,
      {
        title: "Original seeded task",
        description: "Repair the starting tree.",
        columnId: collab.boardStore.columns(projectId)[0]!.id,
      },
      { kind: "person", id: person.userId },
    );
    cardId = card.id;
    collab.boardStore.assign(projectId, cardId, { kind: "agent", id: row.agent as string }, true, {
      kind: "person",
      id: person.userId,
    });
  } finally {
    collab.close();
  }
  const store = new CollabStore({ path: database });
  try {
    const provisioner = new Provisioner(store, state);
    provisioner.fork({ projectId });
    const worktree = provisioner.fork({ projectId, cardId });
    process.stdout.write(JSON.stringify({ projectId, cardId, path: worktree.path }) + "\n");
  } finally {
    store.close();
  }
} catch {
  process.stdout.write('{"failed":true}\n');
  process.exitCode = 1;
}
