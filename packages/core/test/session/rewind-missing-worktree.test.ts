/** Missing D115 linked checkouts release only their owned refs and stale Git registration, then stop maintenance. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { RewindCheckpoints } from "../../src/session/rewind-checkpoints.ts";
import { SessionStore } from "../../src/session/store.ts";

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cx-missing-worktree-")));
  const repository = join(directory, "repository"), root = join(directory, "linked checkout");
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(repository, "tracked.txt"), "original\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("worktree", "add", "--quiet", "--detach", root, "HEAD");
  const path = join(directory, "sessions.sqlite");
  let store = new SessionStore({ path });
  const audit = memoryAuditSink();
  let warnings = 0;
  const open = () => new RewindCheckpoints({ store, audit, now: () => 42, fileProjects: () => ["p"],
    project: () => ({ projectId: "p", cardId: "c", root }), onCleanupError: () => { warnings++; },
    approval: { request: async () => { throw Error("cleanup must never request permission"); }, begin: () => false } });
  let checkpoints = open();
  return { directory, root, repository, git, audit, store: () => store, checkpoints: () => checkpoints,
    warnings: () => warnings,
    async restart() { await checkpoints.close(); store.close(); store = new SessionStore({ path }); checkpoints = open(); },
    async close() { await checkpoints.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const missing of ["directory", "git-metadata"] as const) {
  test(`cleanup of a linked worktree with missing ${missing} reaches a terminal state`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const r = fixture();
    try {
      const tracked = join(r.root, "tracked.txt");
      const beforeCleanup = readFileSync(tracked);
      const session = r.store().createSession({ kind: "card", agentId: "a", owner: "owner" });
      const turn = r.store().beginTurn(session.id, "edit", 1);
      await r.checkpoints().capture({ sessionId: session.id, turnId: turn.turn.id, personId: "owner",
        signal: new AbortController().signal });
      r.store().completeTurn(turn.turn.id, { text: "done", tokens: 1 });
      const record = r.store().checkpoints(session.id)[0]!;
      rmSync(missing === "directory" ? r.root : join(r.root, ".git"), { recursive: true, force: true });
      r.store().archiveSession(session.id);
      await r.checkpoints().idle();
      assert.equal(r.store().hasCheckpoints(), false, "missing roots cannot retain cleanup intents forever");
      assert.equal(r.git("for-each-ref", "--format=%(refname)", record.ref).trim(), "");
      assert.ok(!r.git("worktree", "list", "--porcelain").includes(r.root), "stale linked entry was pruned");
      if (missing === "git-metadata") {
        assert.deepEqual(readFileSync(tracked), beforeCleanup, "cleanup never removes checkout contents");
      }
      assert.ok(r.audit.events.some(event => event.action === "session.checkpoint.pruning"
        && event.detail.result === (missing === "directory" ? "root-missing" : "root-not-repository")));
      const audits = r.audit.events.length;
      for (let i = 0; i < 6; i++) { t.mock.timers.tick(10_000); await r.checkpoints().idle(); }
      assert.equal(r.audit.events.length, audits, "no further maintenance runs after the last intent is gone");
      assert.ok(r.warnings() <= 1);
    } finally { await r.close(); }
  });
}

test("restart releases a missing checkout's persisted common-directory ref after transcript erasure", async () => {
  const r = fixture();
  try {
    const session = r.store().createSession({ kind: "card", agentId: "a", owner: "owner" });
    const turn = r.store().beginTurn(session.id, "edit", 1);
    await r.checkpoints().capture({ sessionId: session.id, turnId: turn.turn.id, personId: "owner",
      signal: new AbortController().signal });
    r.store().completeTurn(turn.turn.id, { text: "done", tokens: 1 });
    const record = r.store().checkpoints(session.id)[0]!;
    await r.checkpoints().close();
    r.store().archiveSession(session.id);
    r.store().eraseSession(session.id, { actor: "owner", reason: "fixture erased after archival" });
    rmSync(r.root, { recursive: true, force: true });
    await r.restart();
    await r.checkpoints().idle();
    assert.equal(r.store().hasCheckpoints(), false);
    assert.equal(r.git("for-each-ref", "--format=%(refname)", record.ref).trim(), "");
    assert.ok(!r.git("worktree", "list", "--porcelain").includes(r.root));
  } finally { await r.close(); }
});

test("a foreign ref remains untouched and cleanup warns at most once across repeated sweeps", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fixture();
  try {
    const session = r.store().createSession({ kind: "card", agentId: "a", owner: "owner" });
    const turn = r.store().beginTurn(session.id, "edit", 1);
    await r.checkpoints().capture({ sessionId: session.id, turnId: turn.turn.id, personId: "owner",
      signal: new AbortController().signal });
    r.store().completeTurn(turn.turn.id, { text: "done", tokens: 1 });
    const record = r.store().checkpoints(session.id)[0]!;
    const foreign = r.git("rev-parse", "HEAD").trim();
    r.git("update-ref", record.ref, foreign);
    r.store().archiveSession(session.id);
    await r.checkpoints().idle();
    for (let i = 0; i < 6; i++) { t.mock.timers.tick(10_000); await r.checkpoints().idle(); }
    assert.equal(r.store().hasCheckpoints(), true, "a conflict remains discoverable");
    assert.equal(r.git("rev-parse", record.ref).trim(), foreign);
    assert.equal(r.warnings(), 1);
  } finally { await r.close(); }
});
