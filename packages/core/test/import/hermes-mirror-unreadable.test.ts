// writeMirrorWithConflict (importers/hermes-memories.ts): with --conflict replace the existing mirror file is copied to
// replaced/ before it is overwritten. A file that cannot be read has no content to copy, so it must not be overwritten
// (an empty "backup" would lose it silently); the write is skipped and reported as target-unreadable. Siblings
// (openclaw-agents: target-unreadable conflict) behave the same. A directory in the file's place cannot be read on any
// platform and as any user; a file without read permission is covered where the permission is enforced (not for root).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { layout } from "../../src/paths.ts";
import { ImportLedger } from "../../src/import/ledger.ts";
import { writeMirrorWithConflict } from "../../src/import/importers/hermes-memories.ts";
import { useTempDirs } from "./helpers.ts";

const tmpDir = useTempDirs();
const put = (file: string, content: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };

function setup() {
  const home = tmpDir();
  const l = layout(home);
  const replacedBackupDir = path.join(home, "imports", "run-1", "replaced");
  const ledger = new ImportLedger(path.join(home, "imports", "run-1", "ledger.jsonl"), "run-1");
  const target = path.join(l.workspaceDir("alpha"), "memories.md");
  const write = (onConflict: "skip" | "rename" | "replace") => writeMirrorWithConflict({
    targetPath: target, content: "imported card\n", relTarget: "workspace/memories.md", sourceRef: "memories/MEMORY.md", agentId: "alpha", onConflict, replacedBackupDir, ledger, l,
  });
  return { home, l, target, replacedBackupDir, ledger, write };
}

describe("writeMirrorWithConflict: an unreadable existing mirror file", () => {
  it("--conflict replace refuses to overwrite it: nothing written, no empty backup, reported, ledgered as conflict-skip", () => {
    const s = setup();
    mkdirSync(s.target, { recursive: true }); // a directory where the file should be: readFileSync throws EISDIR
    put(path.join(s.target, "inner.txt"), "precious");
    assert.equal(s.write("replace"), "target-unreadable");
    assert.equal(readFileSync(path.join(s.target, "inner.txt"), "utf8"), "precious");
    assert.ok(!existsSync(path.join(s.replacedBackupDir, "agents", "alpha", "workspace", "memories.md")), "no backup is written for what cannot be read");
    assert.deepEqual(s.ledger.entries().map((e) => [e.action, e.reason]), [["conflict-skip", "target-unreadable"]]);
  });

  it("--conflict replace refuses a file without read permission", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "permission bits are not enforced (Windows, root)" : false }, () => {
    const s = setup();
    put(s.target, "private notes");
    chmodSync(s.target, 0o200);
    try {
      assert.equal(s.write("replace"), "target-unreadable");
      chmodSync(s.target, 0o600);
      assert.equal(readFileSync(s.target, "utf8"), "private notes");
      assert.ok(!existsSync(s.replacedBackupDir));
    } finally { chmodSync(s.target, 0o600); }
  });
});

describe("writeMirrorWithConflict: readable files keep working", () => {
  it("--conflict replace backs up the old content and writes the new one", () => {
    const s = setup();
    put(s.target, "old notes\n");
    assert.equal(s.write("replace"), undefined);
    assert.equal(readFileSync(s.target, "utf8"), "imported card\n");
    assert.equal(readFileSync(path.join(s.replacedBackupDir, "agents", "alpha", "workspace", "memories.md"), "utf8"), "old notes\n");
    assert.deepEqual(s.ledger.entries().map((e) => e.action), ["replace"]);
  });

  it("--conflict skip leaves a differing file alone; a missing file is created", () => {
    const s = setup();
    assert.equal(s.write("skip"), undefined);
    assert.equal(readFileSync(s.target, "utf8"), "imported card\n");
    put(s.target, "changed\n");
    assert.equal(s.write("skip"), undefined);
    assert.equal(readFileSync(s.target, "utf8"), "changed\n");
  });
});
