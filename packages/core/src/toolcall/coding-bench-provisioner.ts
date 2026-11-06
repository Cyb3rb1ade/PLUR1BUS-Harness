/** B1 consumes #820's sole GitWorktreeProvisioner and K2a's opaque native-turn mount, with no fallback or bypass. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CollabStore } from "../collab/store.ts";
import type { CodingSourceFile } from "./coding-bench-corpus.ts";
import { runCodingCommand } from "./coding-bench-process.ts";
import { writeCodingSources } from "./coding-bench-workspace.ts";

/** Trusted turn binding; the mount is an opaque in-process object, never wire JSON or a path-based grant. */
export interface CodingTurnBinding {
  projectId: string;
  cardId: string;
  principal: string;
  agentId: string;
  worktreeMount: object;
}
/** Everything registered in Git and SQLite is inside one disposable case; only its card path is granted to a turn. */
export interface CodingProvisionedWorkspace {
  home: string;
  worktree: string;
  binding: CodingTurnBinding;
  close(): Promise<void>;
}
interface MountApi {
  fromStore(store: CollabStore, stateDir: string, projectId: string, cardId: string, agentId: string): object;
}

/** Runtime dependency gate permits K2 preparation before #820/K2a merge; it never substitutes an implementation. */
export async function codingProvisionerApi(): Promise<MountApi> {
  const url = new URL("../tools/sandbox/worktree-mount.ts", import.meta.url).href;
  try {
    const namespace = (await import(url)) as Record<string, unknown>;
    const Mount = namespace.WorktreeMount as MountApi | undefined;
    if (!Mount || typeof Mount.fromStore !== "function") throw new Error("missing mount API");
    return Mount;
  } catch {
    throw new Error("coding live requires merged #820 and K2a");
  }
}

/** Author public seed inputs, then invoke the shared provisioner. No host Git ever sees post-agent metadata. */
export async function provisionCodingCard(
  home: string,
  files: ReadonlyMap<string, CodingSourceFile>,
  signal: AbortSignal,
): Promise<CodingProvisionedWorkspace> {
  const api = await codingProvisionerApi();
  const root = await realpath(await mkdtemp(join(home, "coding-workspace-")));
  const caseHome = join(root, "home");
  const repository = join(root, "seed");
  const principal = randomUUID();
  const agentId = "coding-bench";
  let store: CollabStore | undefined;
  try {
    await mkdir(join(caseHome, "state"), { recursive: true, mode: 0o700 });
    await mkdir(repository, { mode: 0o700 });
    await writeCodingSources(repository, files);
    const input = join(root, "provision.json");
    await writeFile(input, JSON.stringify({ repository, home: caseHome, owner: principal, agent: agentId }), {
      mode: 0o600,
      flag: "wx",
    });
    const worker = fileURLToPath(new URL("./coding-bench-provision-worker.ts", import.meta.url));
    const result = await runCodingCommand(
      process.execPath,
      ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", worker, input],
      {
        root,
        signal,
        timeoutMs: 30_000,
        env: {
          PATH: ["/usr/bin", "/bin", "/usr/local/bin", dirname(process.execPath)].join(delimiter),
          HOME: root,
          TMPDIR: root,
          CI: "1",
          LC_ALL: "C",
          GIT_AUTHOR_NAME: "B1 Bench",
          GIT_AUTHOR_EMAIL: "bench@invalid",
          GIT_COMMITTER_NAME: "B1 Bench",
          GIT_COMMITTER_EMAIL: "bench@invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      },
    );
    await rm(input, { force: true });
    if (result.reason || result.code !== 0) throw new Error("shared coding provisioner unavailable");
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provision result");
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "cardId,path,projectId" ||
      typeof row.projectId !== "string" ||
      typeof row.cardId !== "string" ||
      typeof row.path !== "string" ||
      !row.path.startsWith(join(caseHome, "state", "worktrees") + sep)
    )
      throw new Error("invalid card binding");
    store = new CollabStore({ path: join(caseHome, "state", "collab.sqlite") });
    const worktreeMount = api.fromStore(store, join(caseHome, "state"), row.projectId, row.cardId, agentId);
    const opened = store;
    return {
      home: caseHome,
      worktree: row.path,
      binding: { projectId: row.projectId, cardId: row.cardId, principal, agentId, worktreeMount },
      async close() {
        opened.close();
        // Remove the whole private seed/home. Calling GitWorktreeProvisioner.remove after untrusted code would
        // pass possibly edited Git administration to host Git. No registration here points outside this root.
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  } catch (error) {
    store?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}
