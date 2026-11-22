// Record the real private-index diff on a synthetic local Git checkout.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { workingDiff } from "../../packages/core/src/coding/git-view.ts";
import { exporterMain } from "./lib.mjs";

/** Prepare a reproducible detached commit in a fresh fixture repository. */
export function fixtureHead(root: string, runGit: (args: string[], input?: string) => string): string {
  const tree = runGit(["write-tree"]).trim();
  const commit = [
    "tree " + tree,
    "author Fixture <fixture@example.invalid> 1000000000 +0000",
    "committer Fixture <fixture@example.invalid> 1000000000 +0000",
    "",
    "fixture",
    "",
  ].join("\n");
  const head = runGit(["hash-object", "-w", "-t", "commit", "--stdin"], commit);
  writeFileSync(join(root, ".git", "HEAD"), head);
  return head;
}

export function buildCodingGitViewVectors() {
  const dir = mkdtempSync(join(tmpdir(), "p4k-coding-git-view-"));
  const root = realpathSync.native(dir);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull });
  const runGit = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: root, env: environment, encoding: "utf8", stdio: "pipe", timeout: 5_000, input });
  const git = (...args: string[]) => runGit(args);
  try {
    git("init", "--template=", "--object-format=sha1", "-q");
    const file = join(root, "fixture.txt");
    writeFileSync(file, "original fixture\n");
    git("add", "--", "fixture.txt");
    const head = fixtureHead(root, runGit);
    writeFileSync(file, "staged fixture\n");
    git("add", "--", "fixture.txt");
    const indexPath = join(root, ".git", "index");
    const prior = readFileSync(indexPath);
    writeFileSync(file, "working fixture\n");
    const diff = workingDiff(root);
    return { "git-view": { diff, indexUnchanged: prior.equals(readFileSync(indexPath)), headUnchanged: git("rev-parse", "HEAD") === head } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingGitViewVectors });
}
