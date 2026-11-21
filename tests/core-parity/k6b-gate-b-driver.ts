// Mode B: use the real TypeScript CodingGate to write and verify review records.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodingGate } from "../../packages/core/src/collab/coding-gate.ts";

const [op, directory] = process.argv.slice(2);
assert.ok(directory);
const root = join(realpathSync.native(directory), "worktree");
mkdirSync(join(root, "src"), { recursive: true });
const manifest = '{"scripts":{"format":"f","lint":"l","typecheck":"ty","test":"t"}}';
writeFileSync(join(root, "package.json"), manifest);
writeFileSync(join(root, "src", "example.ts"), "fixture");
const head = "a".repeat(40);
const make = (name: string) => new CodingGate({
  path: join(directory, name), audit() {}, isLocalReviewer: () => true,
  git: (_root, args) => {
    switch (args.join(" ")) {
      case "rev-parse --show-toplevel": return root;
      case "rev-parse HEAD": return head;
      case "ls-files -z": return "package.json\0src/example.ts\0";
      case "ls-files --others --exclude-standard -z": return "";
      case "diff --binary HEAD --": return "fixture diff\n";
      case "diff --numstat HEAD --": return "200\t0\tsrc/example.ts\n";
      case "diff --name-only HEAD --": return "src/example.ts\n";
      case "show " + head + ":package.json": return manifest;
      default: throw new Error("not present");
    }
  },
  verifier: { async run() { return { ok: true, exitCode: 0, output: "done" }; } },
});
const task = "project/card";
const ts = "from-ts.sqlite";
const rust = "from-rust.sqlite";

const schema = (name: string) => {
  const db = new DatabaseSync(join(directory, name));
  try {
    return { schema: db.prepare("SELECT name, sql FROM sqlite_master WHERE name = 'coding_reviews'").all(),
      version: db.prepare("PRAGMA user_version").get(), integrity: db.prepare("PRAGMA integrity_check").get() };
  } finally { db.close(); }
};

if (op === "prepare") {
  const gate = make(ts);
  try { gate.recordReview(task, gate.snapshot(root), "reviewer", "writer"); }
  finally { gate.close(); }
} else if (op === "verify") {
  const a = make(ts), b = make(rust);
  try {
    const signal = new AbortController().signal;
    assert.equal((await a.verify({ task: "from-rust", root, signal })).ok, true);
    assert.equal((await b.verify({ task: "new-rust", root, signal })).ok, true);
    assert.equal((await b.verify({ task: "missing", root, signal })).reason, "review-required");
  } finally { a.close(); b.close(); }
  assert.deepEqual(schema(ts), schema(rust));
} else { throw new Error("expected prepare or verify"); }
