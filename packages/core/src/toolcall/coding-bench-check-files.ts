/** Parent-side B1 file observations, restricted to coordinator-created data inside one private verifier root. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, symlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { CodingCaseFailure } from "./coding-bench-box.ts";

/** Private test-data port; no method accepts a path outside its owned root or follows a link. */
export class CodingCheckFiles {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  /** Check every existing component; candidate processes have ended before the coordinator observes files. */
  async safe(path: string, missing = false): Promise<string> {
    const value = resolve(path);
    if (value !== this.root && !value.startsWith(this.root + sep)) throw new CodingCaseFailure("data path escaped");
    let current = this.root;
    for (const part of ["", ...relative(this.root, value).split(sep).filter(Boolean)]) {
      current = part ? join(current, part) : current;
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new CodingCaseFailure("data link refused");
      } catch (error) {
        if (missing && (error as NodeJS.ErrnoException).code === "ENOENT" && current === value) return value;
        throw error;
      }
    }
    return value;
  }

  /** A single child name under a verified directory. */
  async filePath(parent: string, name: string): Promise<string> {
    if (!name || /[/\\\0\r\n]/u.test(name) || name === "." || name === "..") {
      throw new CodingCaseFailure("invalid data name");
    }
    await this.safe(parent);
    return join(parent, name);
  }

  /** Create a private fixture directory. */
  async directory(name: string, parent = this.root): Promise<string> {
    const path = await this.filePath(parent, name);
    await mkdir(path, { mode: 0o700 });
    return path;
  }

  /** Write bounded data without following a leaf link; chmod is explicit even for an existing fixture file. */
  async write(parent: string, name: string, data: string, mode = 0o600): Promise<void> {
    const path = await this.safe(await this.filePath(parent, name), true);
    if (Buffer.byteLength(data) > 1_048_576) throw new CodingCaseFailure("data write limit");
    const file = await open(
      path,
      constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await file.chmod(mode);
      await file.writeFile(data);
    } finally {
      await file.close();
    }
  }

  /** Read only a bounded regular file. */
  async read(parent: string, name: string): Promise<string> {
    const path = await this.safe(await this.filePath(parent, name));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_048_576) throw new CodingCaseFailure("data read limit");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }

  /** Observe final permission bits without following links. */
  async mode(parent: string, name: string): Promise<number> {
    return (await lstat(await this.safe(await this.filePath(parent, name)))).mode & 0o777;
  }

  /** List only the direct fixture directory, including names of links without following them. */
  async names(parent: string): Promise<string[]> {
    return (await readdir(await this.safe(parent))).sort();
  }

  /** Remove a known child; unlinking a leaf symlink never traverses its target. */
  async remove(parent: string, name: string): Promise<void> {
    await rm(await this.filePath(parent, name), { force: true });
  }

  /** A fixture link is always relative to its verified parent, never an arbitrary owner path. */
  async symlink(target: string, name: string, parent: string): Promise<void> {
    await this.filePath(parent, target);
    await symlink(target, await this.filePath(parent, name));
  }
}
