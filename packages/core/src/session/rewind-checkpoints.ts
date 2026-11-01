/** D120 Q14: D115 working-tree checkpoints and human-approved tracked-file restore, with a private temporary Git index. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AuditSink } from "../rbac/audit.ts";
import type { ApprovalAsk, ApprovalPort } from "../tools/approval.ts";
import type { RewindFilesPort, RewindServiceDeps } from "./rewind.ts";
import type { SessionStore } from "./store.ts";
import { SessionError } from "./types.ts";

const execute = promisify(execFile);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OID = /^[a-f0-9]{40,64}$/;
const CHECKPOINT = "refs/plur1bus/checkpoints";
const MAX_PREVIEW_PATHS = 200;
const MAX_PREVIEW_CHARS = 4096;

interface CheckpointDeps {
  store: SessionStore;
  audit: AuditSink;
  now: () => number;
  project: NonNullable<RewindServiceDeps["project"]>;
  approval: ApprovalPort & Required<Pick<ApprovalPort, "begin">>;
}

/** Git environment policy, including case-insensitive Windows names; callers add only trusted operation bindings. */
export function checkpointEnvironment(source: NodeJS.ProcessEnv, index?: string): NodeJS.ProcessEnv {
  // Inherited GIT_DIR/GIT_WORK_TREE/config injection must not redirect a native operation away from the bound root.
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
    ...(index ? { GIT_INDEX_FILE: index } : {}) };
}

async function git(root: string, args: readonly string[], options: {
  signal: AbortSignal; index?: string; config?: readonly string[]; env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const result = await execute("git", ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false",
    "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
    "-c", `core.hooksPath=${devNull}`, "-c", `core.attributesFile=${devNull}`, ...options.config ?? [],
    "-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
    signal: options.signal, env: { ...checkpointEnvironment(process.env, options.index), ...options.env } });
  return result.stdout;
}

function checkpointRef(sessionId: string, turnId: string): string {
  if (!ID.test(sessionId) || !ID.test(turnId)) throw new SessionError("invalid", "invalid checkpoint identity", "rewind-checkpoint");
  return `${CHECKPOINT}/${sessionId}/${turnId}`;
}

async function indexPath(root: string, signal: AbortSignal): Promise<string> {
  const path = resolve(root, (await git(root, ["rev-parse", "--git-path", "index"], { signal })).trim());
  if ((await lstat(path)).isSymbolicLink()) throw new SessionError("conflict", "checkpoint index must not be a link", "rewind-checkpoint");
  return path;
}

async function indexDigest(root: string, signal: AbortSignal): Promise<string> {
  return createHash("sha256").update(await readFile(await indexPath(root, signal))).digest("hex");
}

async function workingIndex<T>(root: string, signal: AbortSignal,
  run: (options: Parameters<typeof git>[2], indexHash: string) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), "p1b-checkpoint-"));
  try {
    const index = join(temporary, "index"), metadata = join(temporary, "git"), template = join(temporary, "template");
    const source = await indexPath(root, signal);
    const bytes = await readFile(source);
    const indexHash = createHash("sha256").update(bytes).digest("hex");
    await copyFile(source, index);
    if (createHash("sha256").update(await readFile(index)).digest("hex") !== indexHash) {
      throw new SessionError("conflict", "index changed while copying the checkpoint", "rewind-files-changed");
    }
    const format = (await git(root, ["rev-parse", "--show-object-format"], { signal })).trim();
    if (format !== "sha1" && format !== "sha256") throw new SessionError("storage", "unsupported Git object format");
    const objects = resolve(root, (await git(root, ["rev-parse", "--git-path", "objects"], { signal })).trim());
    await mkdir(template);
    await git(root, ["init", "--bare", `--template=${template}`, `--object-format=${format}`, metadata], { signal });
    await mkdir(join(metadata, "info"), { recursive: true });
    // Highest-precedence attributes in a trusted temporary Git directory defeat included/worktree config and races
    // introducing a new filter name. Both capture and restore operate on raw bytes, never EOL/encoding/ident transforms.
    await writeFile(join(metadata, "info", "attributes"), "* -filter -text -eol -ident -working-tree-encoding\n");
    const shared = (await git(root, ["rev-parse", "--shared-index-path"], { signal })).trim();
    if (shared) await copyFile(resolve(root, shared), join(metadata, basename(shared)));
    return await run({ signal, index, env: { GIT_DIR: metadata, GIT_WORK_TREE: root, GIT_OBJECT_DIRECTORY: objects } }, indexHash);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function workingTree(root: string, signal: AbortSignal): Promise<{ tree: string; indexHash: string }> {
  return workingIndex(root, signal, async (options, indexHash) => {
    // Re-read all tracked contents: a normal index may cache an EOL-normalized blob for an otherwise unchanged file.
    await git(root, ["add", "--renormalize", "--update", "--", "."], options);
    const tree = (await git(root, ["write-tree"], options)).trim();
    if (!OID.test(tree)) throw new SessionError("storage", "invalid checkpoint tree", "rewind-checkpoint");
    if (await indexDigest(root, signal) !== indexHash) {
      throw new SessionError("conflict", "index changed while preparing the checkpoint", "rewind-files-changed");
    }
    return { tree, indexHash };
  });
}

async function protectUntracked(root: string, tree: string, signal: AbortSignal): Promise<void> {
  const paths = (await git(root, ["ls-tree", "-r", "--name-only", "-z", tree], { signal })).split("\0").filter(Boolean);
  const tracked = new Set((await git(root, ["ls-files", "--cached", "-z"], { signal })).split("\0"));
  for (const path of paths) {
    if (tracked.has(path)) continue;
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index++) {
      try {
        const stat = await lstat(join(root, ...segments.slice(0, index)));
        if (index === segments.length || !stat.isDirectory()) {
          throw new SessionError("conflict", "untracked path would be overwritten by restore", "rewind-files-changed");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
}

/** Both trees are immutable native snapshots. Name-status output never invokes a repository diff program. */
async function restorePreview(root: string, checkpoint: string, current: string, signal: AbortSignal) {
  const raw = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", checkpoint, current, "--"], { signal });
  const fields = raw ? raw.split("\0").slice(0, -1) : [];
  if ((raw && !raw.endsWith("\0")) || fields.length % 2 !== 0 || raw.includes("\uFFFD")) {
    throw new SessionError("storage", "file restore paths cannot be represented exactly", "rewind-files-preview");
  }
  const overwritten: string[] = [], preserved: string[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!, path = fields[i + 1]!;
    if (!/^[AMDT]$/.test(status) || !path) throw new SessionError("storage", "invalid file restore preview", "rewind-files-preview");
    (status === "A" ? preserved : overwritten).push(path);
  }
  const changes = { overwritten, preserved, overwrittenCount: overwritten.length, preservedCount: preserved.length };
  const diff = [`Overlay restore: overwrite ${overwritten.length}; preserve ${preserved.length} newly tracked paths.`,
    ...overwritten.map(path => `Overwrite: ${JSON.stringify(path)}`),
    ...preserved.map(path => `Preserve new tracked: ${JSON.stringify(path)}`)].join("\n");
  // Refuse an incomplete preview rather than ask for an operation whose affected paths cannot all be shown.
  if (overwritten.length + preserved.length > MAX_PREVIEW_PATHS || diff.length > MAX_PREVIEW_CHARS
    || JSON.stringify(changes).length > MAX_PREVIEW_CHARS) {
    throw new SessionError("conflict", "file restore exceeds the bounded approval preview", "rewind-files-preview-limit");
  }
  return { changes, diff };
}

/** Git object/ref writes never stage files, move HEAD or reset the real index. A restore always asks for a once approval. */
export class RewindCheckpoints implements RewindFilesPort {
  readonly #d: CheckpointDeps;
  constructor(deps: CheckpointDeps) { this.#d = deps; }

  async #bound(sessionId: string, personId: string, signal: AbortSignal) {
    const session = this.#d.store.getSession(sessionId);
    const project = session?.kind === "card" && session.memoryMode !== "incognito"
      ? this.#d.project(sessionId, personId) : null;
    if (!session || !project || !personId) {
      throw new SessionError("conflict", "D115 worktree checkpoint unavailable", "rewind-checkpoint-unavailable");
    }
    const root = await realpath(project.root);
    const top = await realpath((await git(root, ["rev-parse", "--show-toplevel"], { signal })).trim());
    if (top !== root) throw new SessionError("conflict", "checkpoint requires the bound worktree root", "rewind-checkpoint");
    return { ...project, root, session };
  }

  /** Before a model turn, snapshot tracked working bytes under the Q14 ref, without touching the real index. */
  async capture(input: { sessionId: string; turnId: string; personId: string; signal: AbortSignal }): Promise<void> {
    const session = this.#d.store.getSession(input.sessionId);
    if (session?.kind !== "card" || session.memoryMode === "incognito"
      || !this.#d.project(input.sessionId, input.personId)) return;
    const bound = await this.#bound(input.sessionId, input.personId, input.signal);
    if (this.#d.store.getTurn(input.turnId)?.sessionId !== session.id) {
      throw new SessionError("invalid", "checkpoint turn is not in the session", "rewind-checkpoint");
    }
    const ref = checkpointRef(session.id, input.turnId);
    const snapshot = await workingTree(bound.root, input.signal);
    const head = (await git(bound.root, ["rev-parse", "--verify", "HEAD"], { signal: input.signal })).trim();
    if (!OID.test(head)) throw new SessionError("conflict", "checkpoint requires a committed worktree", "rewind-checkpoint");
    const commit = (await git(bound.root, ["commit-tree", snapshot.tree, "-p", head, "-m", "PLUR1BUS turn checkpoint"], {
      signal: input.signal, env: { GIT_AUTHOR_NAME: "PLUR1BUS", GIT_AUTHOR_EMAIL: "checkpoint@plur1bus.invalid",
        GIT_COMMITTER_NAME: "PLUR1BUS", GIT_COMMITTER_EMAIL: "checkpoint@plur1bus.invalid" },
    })).trim();
    if (!OID.test(commit)) throw new SessionError("storage", "invalid checkpoint commit", "rewind-checkpoint");
    this.#d.audit.append({ at: this.#d.now(), actor: { user: input.personId, host: "core" },
      action: "session.checkpoint.created", target: session.id, detail: { turnId: input.turnId, ref, tree: snapshot.tree } });
    // The all-zero old value makes a turn checkpoint immutable, including across a restart/retry.
    await git(bound.root, ["update-ref", ref, commit, "0".repeat(commit.length)], { signal: input.signal });
    this.#d.store.recordCheckpoint({ sessionId: session.id, turnId: input.turnId, root: bound.root,
      ref, tree: snapshot.tree, commitId: commit });
  }

  /** Restore tracked working files only after a content-bound, single-use human decision; preserve staging and untracked files. */
  async restore(input: Parameters<RewindFilesPort["restore"]>[0]): Promise<void> {
    if (!input.approver.person) throw new SessionError("immutable", "file restore requires a person", "rewind-person-required");
    const bound = await this.#bound(input.sessionId, input.approver.person, input.signal);
    const ref = checkpointRef(input.sessionId, input.checkpointTurnId);
    const recorded = this.#d.store.checkpoint(input.sessionId, input.checkpointTurnId);
    if (!recorded || recorded.root !== bound.root || recorded.ref !== ref) {
      throw new SessionError("conflict", "recorded rewind checkpoint is unavailable", "rewind-checkpoint-unavailable");
    }
    let checkpoint: string;
    try { checkpoint = (await git(bound.root, ["rev-parse", "--verify", `${ref}^{tree}`], { signal: input.signal })).trim(); }
    catch { throw new SessionError("conflict", "rewind checkpoint is unavailable", "rewind-checkpoint-unavailable"); }
    if (!OID.test(checkpoint)) throw new SessionError("storage", "invalid rewind checkpoint", "rewind-checkpoint");
    const commit = (await git(bound.root, ["rev-parse", "--verify", ref], { signal: input.signal })).trim();
    if (checkpoint !== recorded.tree || commit !== recorded.commitId) {
      throw new SessionError("conflict", "recorded checkpoint was changed outside the harness", "rewind-checkpoint");
    }
    await protectUntracked(bound.root, checkpoint, input.signal);
    const before = await workingTree(bound.root, input.signal);
    const preview = await restorePreview(bound.root, checkpoint, before.tree, input.signal);
    const args = { sessionId: input.sessionId, root: bound.root, ref, checkpoint, beforeTree: before.tree, indexHash: before.indexHash,
      changes: preview.changes };
    const actionHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const ask: ApprovalAsk = { request: { capability: "fs.write", tool: "rewind.files.restore", effect: "local-destructive",
      risk: "high", reversible: true, flags: { outsideRoots: false, denyListHit: false }, actionHash,
      grantOptions: [{ scope: "once", requiredSurface: 2 }], requiredSurface: 2, tainted: false,
      taintSuspended: false, originSurface: input.approver.surface }, callId: randomUUID(), tool: "rewind.files.restore", args,
      agentId: bound.session.agentId, principal: input.approver.person, sessionId: input.sessionId,
      projectId: bound.projectId, targets: [bound.root], diff: preview.diff, access: "write", park: false, signal: input.signal };
    const answer = await this.#d.approval.request(ask);
    input.signal.throwIfAborted();
    if (!answer.approved || answer.scope !== "once") {
      throw new SessionError("immutable", "file restore was not approved", "rewind-files-not-approved");
    }
    const current = await this.#bound(input.sessionId, input.approver.person, input.signal);
    const actual = await workingTree(bound.root, input.signal);
    if (current.root !== bound.root || current.cardId !== bound.cardId || current.projectId !== bound.projectId
      || actual.tree !== before.tree || actual.indexHash !== before.indexHash
      || (await git(bound.root, ["rev-parse", "--verify", `${ref}^{tree}`], { signal: input.signal })).trim() !== checkpoint) {
      throw new SessionError("conflict", "worktree changed while file restore awaited approval", "rewind-files-changed");
    }
    await protectUntracked(bound.root, checkpoint, input.signal);
    input.validate();
    if (!this.#d.approval.begin(answer, ask)) {
      throw new SessionError("immutable", "file approval is missing or already consumed", "rewind-files-not-approved");
    }
    this.#d.audit.append({ at: this.#d.now(), actor: { user: input.approver.person, host: "core" },
      action: "session.rewind.files", target: input.sessionId, detail: { ...args, actionHash, requestId: answer.requestId } });
    await workingIndex(bound.root, input.signal, async (options, indexHash) => {
      if (indexHash !== before.indexHash) throw new SessionError("conflict", "index changed before approved restore", "rewind-files-changed");
      await git(bound.root, ["restore", "--overlay", `--source=${checkpoint}`, "--worktree", "--", "."], options);
    });
    if (await indexDigest(bound.root, input.signal) !== before.indexHash) {
      throw new SessionError("conflict", "index changed during approved restore", "rewind-files-changed");
    }
  }
}
