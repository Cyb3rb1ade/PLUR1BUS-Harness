/** D120 Q14: native Git checkpoints preserve the real index and never restore files without a bound human approval. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../../src/session/store.ts";
import { checkpointEnvironment, RewindCheckpoints } from "../../src/session/rewind-checkpoints.ts";
import { RewindService } from "../../src/session/rewind.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { ApprovalAsk } from "../../src/tools/approval.ts";

function rig(approved: boolean) {
  const root = mkdtempSync(join(tmpdir(), "cx-checkpoint-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  writeFileSync(join(root, "tracked.txt"), "staged\n");
  git("add", "tracked.txt");
  writeFileSync(join(root, "tracked.txt"), "checkpoint working contents\n");
  writeFileSync(join(root, "untracked.txt"), "untracked must survive\n");
  const store = new SessionStore({ path: ":memory:" });
  const session = store.createSession({ kind: "card", agentId: "a", owner: "owner" });
  const audit = memoryAuditSink();
  const asks: ApprovalAsk[] = [];
  let begins = 0;
  let onAsk: (() => void) | undefined;
  const checkpoints = new RewindCheckpoints({ store, audit, now: () => 42,
    project: () => ({ projectId: "p", cardId: "c", root }), approval: {
      request: async ask => { asks.push(ask); onAsk?.(); return { approved, scope: "once" }; },
      begin: () => { begins++; return approved; },
    } });
  return { root, git, store, session, audit, asks, checkpoints, begins: () => begins,
    whenAsked(callback: () => void) { onAsk = callback; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Git routing/config variables are removed with Windows case semantics while ordinary environment survives", () => {
  const env = checkpointEnvironment({ PATH: "/bin", LANG: "en", GIT_DIR: "/foreign", Git_Work_Tree: "/foreign",
    git_config_count: "1", Git_Config_Key_0: "filter.evil.clean" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.LANG, "en");
  assert.equal(env.Git_Work_Tree, undefined);
  assert.equal(env.git_config_count, undefined);
  assert.equal(env.Git_Config_Key_0, undefined);
});

test("checkpoint and approved restore retain dirty working bytes, staged bytes, branch and untracked files", async () => {
  const r = rig(true);
  try {
    const index = readFileSync(join(r.root, ".git", "index"));
    const head = r.git("rev-parse", "HEAD");
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    assert.equal(r.git("show", "-s", "--format=%an <%ae>", `refs/plur1bus/checkpoints/${r.session.id}/${first.turn.id}`).trim(),
      "PLUR1BUS <checkpoint@plur1bus.invalid>", "generated snapshots use a service identity; person attribution belongs in the audit");
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    const service = new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints });
    await service.rewind({ sessionId: r.session.id, toSeq: 0, lesson: "Try another edit.", actor: "owner", files: true,
      approver: { person: "owner", surface: 3 } });
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "checkpoint working contents\n");
    assert.equal(r.git("show", ":tracked.txt"), "staged\n");
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
    assert.equal(r.git("rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(r.root, "untracked.txt"), "utf8"), "untracked must survive\n");
    assert.equal(r.asks.length, 1);
    assert.equal(r.asks[0]?.request.effect, "local-destructive");
    assert.deepEqual(r.asks[0]?.request.grantOptions, [{ scope: "once", requiredSurface: 3 }]);
    assert.equal(r.begins(), 1);
    assert.match(r.git("for-each-ref", "--format=%(refname)", "refs/plur1bus/checkpoints/"),
      new RegExp(`${r.session.id}/${first.turn.id}`));
  } finally { r.close(); }
});

test("a path is reserved during file approval and a changed worktree refuses the stale restore", async () => {
  const r = rig(true);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    r.whenAsked(() => {
      assert.throws(() => r.store.beginTurn(r.session.id, "new instruction", 2), /awaiting or applying approval/);
      writeFileSync(join(r.root, "tracked.txt"), "person changed this during approval\n");
    });
    const service = new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints });
    await assert.rejects(service.rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true,
      approver: { person: "owner", surface: 3 } }), /changed/);
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "person changed this during approval\n");
    assert.equal(r.begins(), 0);
    assert.deepEqual(r.store.rewinds(r.session.id), []);
    assert.equal(r.store.rewindReserved(r.session.id), false);
  } finally { r.close(); }
});

test("checkpoint and restore never execute repository clean, smudge or hook programs", async () => {
  const r = rig(true);
  try {
    const marker = join(r.root, "filter-was-executed");
    const program = join(r.root, ".git", "dangerous-filter");
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
    writeFileSync(join(r.root, ".gitattributes"), "tracked.txt filter=fixture\n");
    r.git("add", ".gitattributes");
    r.git("config", "filter.fixture.clean", `'${program}'`);
    r.git("config", "filter.fixture.smudge", `'${program}'`);
    r.git("config", "filter.fixture.required", "true");
    assert.equal(existsSync(marker), false, "fixture setup");
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    assert.equal(existsSync(marker), false, "checkpoint capture");
    r.whenAsked(() => { assert.equal(existsSync(marker), false, "approval preparation"); });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    writeFileSync(join(r.root, "tracked.txt"), "new bytes\n");
    await new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints })
      .rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 3 } });
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "checkpoint working contents\n");
  } finally { r.close(); }
});

test("refused file approval changes neither tracked files nor the conversation path", async () => {
  const r = rig(false);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    const service = new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints });
    await assert.rejects(service.rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true,
      approver: { person: "owner", surface: 3 } }), /approved/);
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "failed edit\n");
    assert.deepEqual(r.store.rewinds(r.session.id), []);
    assert.equal(r.begins(), 0);
  } finally { r.close(); }
});

test("checkpoint and restore preserve exact CRLF bytes despite repository text/eol attributes", async () => {
  const r = rig(true);
  try {
    writeFileSync(join(r.root, ".gitattributes"), "tracked.txt text eol=lf\n");
    r.git("add", ".gitattributes");
    const original = "native working bytes\r\nsecond line\r\n";
    writeFileSync(join(r.root, "tracked.txt"), original);
    const index = readFileSync(join(r.root, ".git", "index"));
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    const ref = `refs/plur1bus/checkpoints/${r.session.id}/${first.turn.id}`;
    assert.equal(r.git("show", `${ref}:tracked.txt`), original, "checkpoint contains working bytes, not Git-normalized content");
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    await new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints })
      .rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 3 } });
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), original);
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
  } finally { r.close(); }
});

test("included repository filter configuration cannot execute during capture or restore", async () => {
  const r = rig(true);
  try {
    const marker = join(r.root, "included-filter-executed");
    const program = join(r.root, ".git", "included-filter");
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
    const include = join(r.root, ".git", "filters.include");
    for (const phase of ["clean", "smudge"]) r.git("config", "--file", include, `filter.included.${phase}`, `'${program}'`);
    r.git("config", "--file", include, "filter.included.required", "true");
    r.git("config", "include.path", include);
    writeFileSync(join(r.root, ".gitattributes"), "tracked.txt filter=included\n");
    r.git("add", ".gitattributes");
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    assert.equal(existsSync(marker), false, "an included filter never runs in the native core");
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    await new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints })
      .rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 3 } });
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "checkpoint working contents\n");
  } finally { r.close(); }
});

test("a split real index keeps its exact bytes while a private checkpoint restores working contents", async () => {
  const r = rig(true);
  try {
    r.git("update-index", "--split-index");
    const index = readFileSync(join(r.root, ".git", "index"));
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    await new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints })
      .rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 3 } });
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "checkpoint working contents\n");
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
  } finally { r.close(); }
});

test("conversation-only rewind never restores files and an unavailable checkpoint refuses --files", async () => {
  const r = rig(true);
  try {
    const turn = r.store.beginTurn(r.session.id, "edit", 1);
    r.store.completeTurn(turn.turn.id, { text: "failed", tokens: 1 });
    const service = new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints });
    await assert.rejects(service.rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true,
      approver: { person: "owner", surface: 3 } }), /checkpoint/);
    await service.rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", lesson: "Try again." });
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "checkpoint working contents\n");
    assert.equal(r.asks.length, 0);
  } finally { r.close(); }
});

test("restore refuses a checkpoint path that has become an untracked file", async () => {
  const r = rig(true);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    r.git("rm", "--cached", "-f", "tracked.txt");
    writeFileSync(join(r.root, "tracked.txt"), "now untracked, preserve me\n");
    await assert.rejects(new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints })
      .rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true,
        approver: { person: "owner", surface: 3 } }), /untracked/);
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "now untracked, preserve me\n");
    assert.deepEqual(r.store.rewinds(r.session.id), []);
  } finally { r.close(); }
});

test("a Git ref changed outside the checkpoint service cannot impersonate the recorded turn checkpoint", async () => {
  const r = rig(true);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    r.git("update-ref", `refs/plur1bus/checkpoints/${r.session.id}/${first.turn.id}`, "HEAD");
    await assert.rejects(new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints })
      .rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true,
        approver: { person: "owner", surface: 3 } }), /checkpoint.*changed/);
    assert.equal(r.asks.length, 0);
    assert.deepEqual(r.store.rewinds(r.session.id), []);
  } finally { r.close(); }
});

test("overlay restore preserves files staged after the checkpoint and the real index", async () => {
  const r = rig(true);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner", signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    writeFileSync(join(r.root, "new-tracked.txt"), "new staged file must survive\n");
    r.git("add", "new-tracked.txt");
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    const index = readFileSync(join(r.root, ".git", "index")), head = r.git("rev-parse", "HEAD");
    await new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints }).rewind({
      sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 3 } });
    assert.equal(existsSync(join(r.root, "new-tracked.txt")), true, "a newly staged path must not be deleted");
    assert.equal(readFileSync(join(r.root, "new-tracked.txt"), "utf8"), "new staged file must survive\n");
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "checkpoint working contents\n");
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
    assert.equal(r.git("rev-parse", "HEAD"), head);
  } finally { r.close(); }
});

test("the approval preview names overwritten and preserved new paths with their counts", async () => {
  const r = rig(false);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner", signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    writeFileSync(join(r.root, "new-tracked.txt"), "preserve\n"); r.git("add", "new-tracked.txt");
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    await assert.rejects(new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints }).rewind({
      sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 3 } }), /not approved/);
    const ask = r.asks[0]!;
    assert.match(ask.diff ?? "", /tracked\.txt/);
    assert.match(ask.diff ?? "", /new-tracked\.txt/);
    assert.deepEqual((ask.args as { changes: unknown }).changes, {
      overwritten: ["tracked.txt"], preserved: ["new-tracked.txt"], overwrittenCount: 1, preservedCount: 1,
    });
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "failed edit\n");
    assert.equal(r.begins(), 0);
  } finally { r.close(); }
});

test("a checkpoint file cannot replace a directory containing a newly tracked path", async () => {
  const r = rig(true);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner", signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    rmSync(join(r.root, "tracked.txt")); mkdirSync(join(r.root, "tracked.txt"));
    writeFileSync(join(r.root, "tracked.txt", "new-child.txt"), "keep child\n"); r.git("add", "-A");
    await assert.rejects(new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints }).rewind({
      sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 3 } }), { reason: "rewind-files-changed" });
    assert.equal(readFileSync(join(r.root, "tracked.txt", "new-child.txt"), "utf8"), "keep child\n");
    assert.equal(r.asks.length, 0);
  } finally { r.close(); }
});

test("a restore whose complete path preview exceeds the cap asks nobody and changes no working files", async () => {
  const r = rig(true);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner", signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    const names = Array.from({ length: 201 }, (_, i) => `new-${i}.txt`);
    for (const name of names) writeFileSync(join(r.root, name), "preserve\n");
    r.git("add", ...names); writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    const index = readFileSync(join(r.root, ".git", "index"));
    await assert.rejects(new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints }).rewind({
      sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 3 } }), { reason: "rewind-files-preview-limit" });
    assert.equal(r.asks.length, 0); assert.equal(r.begins(), 0);
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "failed edit\n");
    assert.ok(names.every(name => existsSync(join(r.root, name))));
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
  } finally { r.close(); }
});
