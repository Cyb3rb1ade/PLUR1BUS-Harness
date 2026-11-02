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
import { Compactor } from "../../src/session/compaction.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { ApprovalAsk, ApprovalPort } from "../../src/tools/approval.ts";
import { rig as approvalRig, tick } from "../approvals/service-helpers.ts";

function rig(approved: boolean, approval?: ApprovalPort & Required<Pick<ApprovalPort, "begin">>, policy: {
  projects?: () => readonly string[]; retention?: () => number; cardEnded?: () => boolean;
} = {}) {
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
  let projectLookups = 0;
  let onAsk: (() => void) | undefined;
  const checkpoints = new RewindCheckpoints({ store, audit, now: () => 42,
    fileProjects: policy.projects ?? (() => ["p"]), retentionTurns: policy.retention ?? (() => 50),
    cardEnded: policy.cardEnded ?? (() => false),
    project: () => { projectLookups++; return { projectId: "p", cardId: "c", root }; }, approval: {
      request: async ask => {
        asks.push(ask);
        const answer = approval ? approval.request(ask) : Promise.resolve({ approved, scope: "once" as const });
        onAsk?.(); return answer;
      },
      begin: (answer, ask) => { begins++; return approval ? approval.begin(answer, ask) : approved; },
    } });
  return { root, git, store, session, audit, asks, checkpoints, begins: () => begins, projectLookups: () => projectLookups,
    whenAsked(callback: () => void) { onAsk = callback; },
    async close() { await checkpoints.close?.(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function runnerForFiles(r: ReturnType<typeof rig>, warn: (message: string) => void = () => {}) {
  let modelCalls = 0;
  const rewind = new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints });
  const runner = new TurnRunner({ store: r.store, compactor: new Compactor(r.store), checkpoints: r.checkpoints, rewind,
    logger: { info: () => {}, warn },
    memory: { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} },
    provider: () => new FakeChatProvider({ onRequest: () => {
      modelCalls++;
      writeFileSync(join(r.root, "tracked.txt"), modelCalls === 1 ? "target bytes\n" : `failed attempt ${modelCalls}\n`);
    } }) });
  const submit = (text: string) => runner.submit({ session: r.session,
    caller: { channel: "cli", accountId: "local", userId: "owner" }, text, authenticatedPerson: "owner",
    approver: { person: "owner", surface: 2 } }).done;
  return { runner, submit, modelCalls: () => modelCalls };
}

test("a project allowlist containing only another project skips capture without a turn warning", async () => {
  const r = rig(true, undefined, { projects: () => ["another-project"] });
  const warnings: string[] = [], h = runnerForFiles(r, message => { warnings.push(message); });
  try {
    assert.equal((await h.submit("ordinary task in an opted-out project")).state, "completed");
    assert.deepEqual(warnings, []);
    assert.deepEqual(r.store.checkpoints(r.session.id), []);
    assert.equal(r.git("for-each-ref", "--format=%(refname)", "refs/plur1bus/checkpoints").trim(), "");
    assert.equal(r.asks.length, 0);
    assert.equal(h.modelCalls(), 1);
  } finally { await h.runner.idle(); await r.close(); }
});

test("the restore's independent scope guard rejects a fake port that returns always", async () => {
  const r = rig(true, { request: async () => ({ approved: true, scope: "always" }), begin: () => true });
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    await assert.rejects(new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints }).rewind({
      sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 2 } }),
    { name: "SessionError", reason: "rewind-files-not-approved" });
    assert.equal(r.asks.length, 1);
    assert.equal(r.begins(), 0);
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "failed edit\n");
    assert.deepEqual(r.store.rewinds(r.session.id), []);
  } finally { await r.close(); }
});

test("command turns between the target and an attempt never become file-checkpoint candidates", async () => {
  const r = rig(true), h = runnerForFiles(r);
  try {
    assert.equal((await h.submit("kept task")).state, "completed");
    assert.equal((await h.submit("/compact --explain")).state, "completed");
    const command = r.store.listTurns(r.session.id).at(-1)!;
    assert.ok(!r.store.checkpoints(r.session.id).some(row => row.turnId === command.id));
    assert.equal((await h.submit("failed attempt")).state, "completed");
    const result = await h.submit('/rewind 2 --files --lesson "Keep the target state."');
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "target bytes\n");
    assert.equal(r.asks.length, 1);
    assert.equal(h.modelCalls(), 2, "commands never ask a model or capture their own checkpoint");
  } finally { await h.runner.idle(); await r.close(); }
});

test("a second rewind to the same target uses the older discarded attempt's original file checkpoint", async () => {
  const r = rig(true), h = runnerForFiles(r);
  try {
    await h.submit("kept task");
    await h.submit("first failed attempt");
    assert.equal((await h.submit('/rewind 2 --lesson "First lesson."')).state, "completed");
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "failed attempt 2\n");
    await h.submit("second failed attempt");
    const result = await h.submit('/rewind 2 --files --lesson "Second lesson."');
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "target bytes\n");
    assert.equal(r.store.rewinds(r.session.id).length, 2);
    assert.equal(r.asks.length, 1);
    assert.equal(h.modelCalls(), 3);
  } finally { await h.runner.idle(); await r.close(); }
});

test("an unstaged deletion can be captured and restored without changing the real index or HEAD", async () => {
  const r = rig(true);
  try {
    const name = "gone file ü.txt";
    writeFileSync(join(r.root, name), "original bytes\r\n");
    r.git("add", name);
    r.git("commit", "-qm", "tracked deletion fixture");
    const index = readFileSync(join(r.root, ".git", "index"));
    const head = r.git("rev-parse", "HEAD");
    const first = r.store.beginTurn(r.session.id, "first edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal });
    rmSync(join(r.root, name));
    r.store.completeTurn(first.turn.id, { text: "removed a file", tokens: 1 });
    const second = r.store.beginTurn(r.session.id, "continue the failed attempt", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: second.turn.id, personId: "owner",
      signal: new AbortController().signal });
    r.store.completeTurn(second.turn.id, { text: "still missing", tokens: 1 });
    assert.equal(r.store.checkpoints(r.session.id).length, 2);
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
    const service = new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints });
    await service.rewind({ sessionId: r.session.id, toSeq: 0, lesson: "Keep the required file.", actor: "owner",
      files: true, approver: { person: "owner", surface: 2 } });
    assert.equal(r.asks.length, 1);
    assert.match(r.asks[0]!.diff ?? "", /gone file ü\.txt/);
    assert.deepEqual(readFileSync(join(r.root, name)), Buffer.from("original bytes\r\n"));
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
    assert.equal(r.git("rev-parse", "HEAD"), head);
  } finally { await r.close(); }
});

test("a failed checkpoint Git operation has the typed storage reason without exposing stderr", async () => {
  const r = rig(true);
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    rmSync(join(r.root, ".git"), { recursive: true, force: true });
    await assert.rejects(r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner",
      signal: new AbortController().signal }), { name: "SessionError", code: "storage", reason: "rewind-checkpoint",
      message: "checkpoint Git failed" });
    assert.equal(r.asks.length, 0);
  } finally { await r.close(); }
});

test("checkpoint projects default off: no snapshot, no grant request and a typed --files refusal", async () => {
  const r = rig(true, undefined, { projects: () => [] });
  try {
    const index = readFileSync(join(r.root, ".git", "index"));
    const start = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: start.turn.id, personId: "owner", signal: new AbortController().signal });
    assert.equal(r.store.checkpoint(r.session.id, start.turn.id), null);
    assert.equal(r.projectLookups(), 0, "a disabled checkpoint does not scan boards");
    assert.equal(r.git("for-each-ref", "--format=%(refname)", "refs/plur1bus/checkpoints").trim(), "");
    r.store.completeTurn(start.turn.id, { text: "done", tokens: 1 });
    await assert.rejects(new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints })
      .rewind({ sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 2 } }),
    { reason: "rewind-files-disabled" });
    assert.equal(r.asks.length, 0); assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
  } finally { await r.close(); }
});

test("checkpoint capture resolves the D115 board binding once per turn", async () => {
  const r = rig(true);
  try {
    const start = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: start.turn.id, personId: "owner", signal: new AbortController().signal });
    assert.equal(r.projectLookups(), 1);
  } finally { await r.close(); }
});

test("cleanup refuses a private ref whose object identity was changed externally", async () => {
  const r = rig(true, undefined, { retention: () => 1 });
  try {
    const first = r.store.beginTurn(r.session.id, "first", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner", signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "done", tokens: 1 });
    const recorded = r.store.checkpoint(r.session.id, first.turn.id)!;
    r.git("update-ref", recorded.ref, "HEAD");
    const foreign = r.git("rev-parse", recorded.ref);
    const second = r.store.beginTurn(r.session.id, "second", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: second.turn.id, personId: "owner", signal: new AbortController().signal });
    assert.equal(r.git("rev-parse", recorded.ref), foreign);
    assert.deepEqual(r.store.checkpoint(r.session.id, first.turn.id), recorded);
  } finally { await r.close(); }
});

test("immediate transcript erasure after archive cannot orphan its private checkpoint refs", async () => {
  const r = rig(true);
  try {
    const start = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: start.turn.id, personId: "owner", signal: new AbortController().signal });
    r.store.completeTurn(start.turn.id, { text: "done", tokens: 1 });
    r.store.archiveSession(r.session.id);
    r.store.eraseSession(r.session.id, { actor: "owner", reason: "explicit deletion" });
    await r.checkpoints.idle();
    assert.equal(r.git("for-each-ref", "--format=%(refname)", `refs/plur1bus/checkpoints/${r.session.id}`).trim(), "");
    assert.equal(r.store.checkpoint(r.session.id, start.turn.id), null);
  } finally { await r.close(); }
});

test("an interrupted ref publication keeps discoverable intent that archive cleanup can remove", async () => {
  const r = rig(true), cancel = new AbortController();
  try {
    const record = r.store.recordCheckpoint.bind(r.store);
    r.store.recordCheckpoint = checkpoint => { record(checkpoint); cancel.abort(); };
    const start = r.store.beginTurn(r.session.id, "edit", 1);
    await assert.rejects(r.checkpoints.capture({ sessionId: r.session.id, turnId: start.turn.id, personId: "owner", signal: cancel.signal }),
      { name: "AbortError" });
    assert.ok(r.store.checkpoint(r.session.id, start.turn.id));
    r.store.failTurn(start.turn.id, "cancelled"); r.store.archiveSession(r.session.id);
    await r.checkpoints.idle();
    assert.equal(r.store.checkpoint(r.session.id, start.turn.id), null);
    assert.equal(r.git("for-each-ref", "--format=%(refname)", `refs/plur1bus/checkpoints/${r.session.id}`).trim(), "");
  } finally { await r.close(); }
});

test("retention removes refs older than N turns while preserving transcript bytes and the real index", async () => {
  const r = rig(true, undefined, { retention: () => 2 });
  try {
    const index = readFileSync(join(r.root, ".git", "index"));
    const turns: string[] = [];
    for (let i = 0; i < 3; i++) {
      const start = r.store.beginTurn(r.session.id, `edit ${i}`, 1); turns.push(start.turn.id);
      await r.checkpoints.capture({ sessionId: r.session.id, turnId: start.turn.id, personId: "owner", signal: new AbortController().signal });
      r.store.completeTurn(start.turn.id, { text: "done", tokens: 1 });
    }
    const refs = r.git("for-each-ref", "--format=%(refname)", `refs/plur1bus/checkpoints/${r.session.id}`).trim().split("\n");
    assert.equal(refs.length, 2); assert.ok(refs.every(ref => !ref.endsWith(turns[0]!)));
    assert.equal(r.store.checkpoint(r.session.id, turns[0]!), null);
    assert.equal(r.store.listMessages(r.session.id).length, 6);
    assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
  } finally { await r.close(); }
});

for (const ending of ["archive", "card-done"] as const) {
  test(`${ending} releases private checkpoint refs and keeps the transcript`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let ended = false;
    const r = rig(true, undefined, { cardEnded: () => ended });
    try {
      const start = r.store.beginTurn(r.session.id, "edit", 1);
      await r.checkpoints.capture({ sessionId: r.session.id, turnId: start.turn.id, personId: "owner", signal: new AbortController().signal });
      r.store.completeTurn(start.turn.id, { text: "done", tokens: 1 });
      const messages = r.store.listMessages(r.session.id), events = r.store.listEvents(r.session.id);
      if (ending === "archive") r.store.archiveSession(r.session.id);
      else { ended = true; t.mock.timers.tick(10_000); }
      await r.checkpoints.idle?.();
      assert.equal(r.git("for-each-ref", "--format=%(refname)", `refs/plur1bus/checkpoints/${r.session.id}`).trim(), "");
      assert.equal(r.store.checkpoint(r.session.id, start.turn.id), null);
      assert.deepEqual(r.store.listMessages(r.session.id), messages);
      assert.deepEqual(r.store.listEvents(r.session.id).slice(0, events.length), events);
    } finally { await r.close(); }
  });
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
    assert.deepEqual(r.asks[0]?.request.grantOptions, [{ scope: "once", requiredSurface: 2 }]);
    assert.equal(r.begins(), 1);
    assert.match(r.git("for-each-ref", "--format=%(refname)", "refs/plur1bus/checkpoints/"),
      new RegExp(`${r.session.id}/${first.turn.id}`));
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
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
  } finally { await r.close(); }
});

test("the real approval service refuses T1 and permits one redacted T2 restore with matching metadata", async () => {
  const permissions = await approvalRig({ service: { secrets: ["new-tracked.txt"] } });
  const r = rig(true, permissions.service);
  let requestId = "";
  try {
    const first = r.store.beginTurn(r.session.id, "edit", 1);
    await r.checkpoints.capture({ sessionId: r.session.id, turnId: first.turn.id, personId: "owner", signal: new AbortController().signal });
    r.store.completeTurn(first.turn.id, { text: "failed", tokens: 1 });
    writeFileSync(join(r.root, "new-tracked.txt"), "preserve\n"); r.git("add", "new-tracked.txt");
    writeFileSync(join(r.root, "tracked.txt"), "failed edit\n");
    r.whenAsked(() => {
      const request = permissions.service.list({ principal: "owner", status: "pending" })[0]; assert.ok(request);
      requestId = request.id;
      const untrusted = permissions.service.decideForSession({ requestId, person: "owner", surface: 1, decision: "approve", scope: "once" });
      assert.equal(untrusted.ok, false);
      assert.equal(permissions.service.get(requestId, "owner")?.status, "pending");
      assert.deepEqual(permissions.service.decideForSession({ requestId, person: "owner", surface: 2,
        decision: "approve", scope: "always" }), { ok: false, reason: "scope-unavailable" });
      assert.equal(permissions.stores.grants.inspect({ person: "owner" }).length, 0);
      assert.equal(permissions.service.get(requestId, "owner")?.status, "pending");
      assert.equal(permissions.stores.grants.inspect({ person: "owner" }).length, 0);
      assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "failed edit\n");
      const trusted = permissions.service.decideForSession({ requestId, person: "owner", surface: 2, decision: "approve", scope: "once" });
      assert.equal(trusted.ok, true);
    });
    await new RewindService({ store: r.store, audit: r.audit, now: () => 42, files: r.checkpoints }).rewind({
      sessionId: r.session.id, toSeq: 0, actor: "owner", files: true, approver: { person: "owner", surface: 1 } });
    assert.equal(readFileSync(join(r.root, "tracked.txt"), "utf8"), "checkpoint working contents\n");
    assert.equal(readFileSync(join(r.root, "new-tracked.txt"), "utf8"), "preserve\n");
    assert.equal(r.begins(), 1, "the actual approval and once grant were consumed before writing");
    const record = permissions.service.get(requestId, "owner"); assert.ok(record);
    assert.doesNotMatch(JSON.stringify({ summary: record.summary, diff: record.diff }), /new-tracked\.txt/);
    assert.match(record.diff ?? "", /tracked\.txt/);
    assert.equal(record.requiredSurface, 2);
    assert.deepEqual(record.grantOptions, [{ scope: "once", requiredSurface: 2 }]);
    const grants = permissions.stores.grants.inspect({ person: "owner" });
    assert.equal(grants.length, 1);
    assert.ok(grants.every(view => view.grant.scope === "once"));
  } finally { permissions.service.dispose(); await tick(); permissions.stores.close(); await r.close(); }
});
