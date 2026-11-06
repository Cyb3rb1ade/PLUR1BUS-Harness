/** A stopped cleanup observer and transcript erasure cannot erase the durable intent to release native refs. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { checkpointEnvironment, RewindCheckpoints } from "../../src/session/rewind-checkpoints.ts";
import { SessionStore } from "../../src/session/store.ts";

test("restart releases checkpoint refs even when their transcript was erased while cleanup was stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "cx-checkpoint-restart-")), db = join(root, "sessions.sqlite");
  const nullDevice = process.platform === "win32" ? "NUL" : devNull;
  const git = (...args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${nullDevice}`, "-C", root, ...args],
    { encoding: "utf8", env: checkpointEnvironment(process.env) });
  let store: SessionStore | undefined, checkpoints: RewindCheckpoints | undefined;
  try {
    git("init", "-q"); writeFileSync(join(root, "tracked.txt"), "checkpoint bytes\n"); git("add", "tracked.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    store = new SessionStore({ path: db });
    const session = store.createSession({ kind: "card", agentId: "a", owner: "owner" });
    const project = () => ({ projectId: "p", cardId: "c", root });
    const approval = { request: async () => ({ approved: false }), begin: () => false };
    checkpoints = new RewindCheckpoints({ store, audit: memoryAuditSink(), now: Date.now, project, approval, fileProjects: () => ["p"] });
    const turn = store.beginTurn(session.id, "edit", 1);
    await checkpoints.capture({ sessionId: session.id, turnId: turn.turn.id, personId: "owner", signal: new AbortController().signal });
    store.completeTurn(turn.turn.id, { text: "done", tokens: 1 });
    await checkpoints.close();
    store.archiveSession(session.id); store.eraseSession(session.id, { actor: "owner", reason: "explicit deletion" });
    assert.ok(git("for-each-ref", "--format=%(refname)", "refs/plur1bus/checkpoints").trim());
    store.close(); store = new SessionStore({ path: db });
    checkpoints = new RewindCheckpoints({ store, audit: memoryAuditSink(), now: Date.now,
      project: () => { throw Error("an erased session has no live binding"); }, approval });
    await checkpoints.idle();
    assert.equal(git("for-each-ref", "--format=%(refname)", "refs/plur1bus/checkpoints").trim(), "");
    assert.equal(store.hasCheckpoints(), false);
    assert.equal(store.getSession(session.id), null);
    assert.equal(store.erasures().length, 1);
  } finally { await checkpoints?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); }
});
