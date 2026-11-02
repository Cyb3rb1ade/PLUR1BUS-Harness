/** A human diff may read a repository, never execute its filters or change its index/object store. */
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { RpcError } from "../rpc/errors.ts";
import { codingGit, gitLine } from "./git.ts";

const MAX_INDEX = 64 * 1024 * 1024;
function copyIndex(source: string, target: string): boolean {
  let fd: number;
  try {
    fd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_INDEX)
      throw new RpcError("E_NOT_AVAILABLE", "Git index is not a bounded regular file");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new RpcError("E_CONFLICT", "Git index changed during the diff");
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new RpcError("E_CONFLICT", "Git index changed during the diff");
    writeFileSync(target, bytes, { mode: 0o600 });
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Git accepts C-quoted alternate-object paths, including path separators, quotes and native Windows backslashes.
 * https://git-scm.com/docs/git#Documentation/git.txt-codeGITALTERNATEOBJECTDIRECTORIEScode */
function quotedPath(path: string): string {
  return (
    '"' +
    [...path]
      .map((c) =>
        c === '"' || c === "\\"
          ? "\\" + c
          : c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
            ? "\\" + c.charCodeAt(0).toString(8).padStart(3, "0")
            : c,
      )
      .join("") +
    '"'
  );
}

/** Capture tracked working bytes in a private Git directory. Original objects are read-only alternates. */
export function workingDiff(root: string): string {
  const temporary = mkdtempSync(join(tmpdir(), "p1b-coding-diff-"));
  try {
    const metadata = join(temporary, "git"),
      template = join(temporary, "template"),
      index = join(temporary, "index");
    const format = gitLine(codingGit(root, ["rev-parse", "--show-object-format"]));
    if (format !== "sha1" && format !== "sha256")
      throw new RpcError("E_NOT_AVAILABLE", "unsupported Git object format");
    const objects = resolve(root, gitLine(codingGit(root, ["rev-parse", "--git-path", "objects"])));
    const source = resolve(root, gitLine(codingGit(root, ["rev-parse", "--git-path", "index"])));
    const hasIndex = copyIndex(source, index);
    mkdirSync(template);
    codingGit(root, ["init", "--bare", `--template=${template}`, `--object-format=${format}`, metadata]);
    mkdirSync(join(metadata, "info"), { recursive: true });
    writeFileSync(join(metadata, "info", "attributes"), "* -filter -text -eol -ident -working-tree-encoding\n");
    const shared = gitLine(codingGit(root, ["rev-parse", "--shared-index-path"]));
    if (shared) copyIndex(resolve(root, shared), join(metadata, basename(shared)));
    const environment = {
      GIT_DIR: metadata,
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: join(metadata, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: quotedPath(objects),
    };
    const git = (args: readonly string[]) => codingGit(root, args, 4 * 1024 * 1024, environment);
    let head: string | null = null;
    try {
      head = gitLine(codingGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]));
    } catch {
      /* unborn */
    }
    if (head && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head))
      throw new RpcError("E_NOT_AVAILABLE", "invalid Git HEAD");
    if (head) writeFileSync(join(metadata, "HEAD"), head + "\n");
    const base = head ?? gitLine(git(["hash-object", "-w", "-t", "tree", "--stdin"]));
    if (!hasIndex) git(["read-tree", "--empty"]);
    // Renormalization stats every indexed path; reconcile deletions in the private index before it runs.
    git(["add", "--update", "--"]);
    git(["add", "--renormalize", "--update", "--"]);
    return git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", base, "--"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
