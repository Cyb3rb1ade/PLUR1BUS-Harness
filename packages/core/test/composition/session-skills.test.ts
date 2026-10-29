// N-C1/C4/D1: frozen catalogue bytes and completed, owned skill events survive a Core restart safely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../src/session/store.ts";
import { MIGRATIONS, migrate } from "../../src/session/migrations.ts";
import { restoreSessionSkills } from "../../src/composition/session-skills.ts";
import { useTempDirs } from "./helpers.ts";

const dirs = useTempDirs("n-session-skills-");

function setup(path = ":memory:") {
  const store = new SessionStore({ path });
  dirs.onCleanup(() => store.close());
  const session = store.createSession({ kind: "direct", agentId: "agent", owner: "owner" });
  return { store, session, req: { sessionId: session.id, agentId: "agent", principal: "owner" } };
}

function pair(store: SessionStore, turnId: string, id: string, name: string, output?: string) {
  const text = output ?? JSON.stringify({ isError: false, value: { name, text: `Workflow for ${name}.`,
    files: ["SKILL.md"] }, truncated: false });
  store.appendEvent(turnId, "tool.call", { id, name: "skill.load", args: { name } });
  store.appendEvent(turnId, "tool.result", { id, output: text });
  return text;
}

test("the latest completed skill selection and original successful result envelope are restored", () => {
  const { store, session, req } = setup();
  const { turn } = store.beginTurn(session.id, "Create a report", 4);
  store.appendEvent(turn.id, "skills.selected", { skills: [{ id: "skill:reports", source: "rule" }] });
  const output = pair(store, turn.id, "load-report", "reports");
  store.completeTurn(turn.id, { text: "Report done", tokens: 3 });
  assert.deepEqual(restoreSessionSkills(store, req), {
    selected: ["skill:reports"], loaded: [{ id: "load-report", name: "reports", text: output, turnId: turn.id }],
  });
});

test("foreign, missing or mismatched session identities reveal no selection or loaded text", () => {
  const { store, session, req } = setup();
  const { turn } = store.beginTurn(session.id, "Report", 2);
  store.appendEvent(turn.id, "skills.selected", { skills: [{ id: "skill:reports" }] });
  pair(store, turn.id, "load", "reports");
  store.completeTurn(turn.id, { text: "Done", tokens: 1 });
  for (const request of [{ ...req, principal: "other" }, { ...req, agentId: "other" },
    { ...req, sessionId: "missing" }, { sessionId: req.sessionId, agentId: req.agentId }]) {
    assert.deepEqual(restoreSessionSkills(store, request), { selected: [], loaded: [] });
  }
});

test("failed and running turns cannot replace a completed skill selection or add loaded instructions", () => {
  const { store, session, req } = setup();
  const first = store.beginTurn(session.id, "Report", 1).turn;
  store.appendEvent(first.id, "skills.selected", { skills: [{ id: "skill:reports" }] });
  const original = pair(store, first.id, "original", "reports");
  store.completeTurn(first.id, { text: "Done", tokens: 1 });
  const failed = store.beginTurn(session.id, "Private", 1).turn;
  store.appendEvent(failed.id, "skills.selected", { skills: [{ id: "skill:private" }] });
  pair(store, failed.id, "failed", "private");
  store.failTurn(failed.id, "interrupted");
  const running = store.beginTurn(session.id, "Pending", 1).turn;
  store.appendEvent(running.id, "skills.selected", { skills: [{ id: "skill:pending" }] });
  pair(store, running.id, "pending", "pending");
  assert.deepEqual(restoreSessionSkills(store, req), {
    selected: ["skill:reports"], loaded: [{ id: "original", name: "reports", text: original, turnId: first.id }],
  });
});

test("only matching successful untruncated load pairs with bounded text can mark a skill loaded", () => {
  const { store, session, req } = setup();
  const { turn } = store.beginTurn(session.id, "Load resources", 2);
  const invalid = ["not json", JSON.stringify({ isError: true, error: { code: "tool-failed" } }),
    JSON.stringify({ isError: false, truncated: true, reference: "tool-result:x" }),
    JSON.stringify({ isError: false, value: { name: "wrong", text: "Wrong workflow", files: [] } }),
    JSON.stringify({ isError: false, value: { name: "reports", text: "x".repeat(64 * 1024 + 1), files: [] } })];
  for (const [index, output] of invalid.entries()) pair(store, turn.id, `bad-${index}`, "reports", output);
  store.appendEvent(turn.id, "tool.result", { id: "unpaired", output: JSON.stringify({ isError: false,
    value: { name: "reports", text: "Unpaired", files: [] } }) });
  store.completeTurn(turn.id, { text: "Done", tokens: 1 });
  assert.deepEqual(restoreSessionSkills(store, req), { selected: [], loaded: [] });
});

test("loaded skills deduplicate by name using the latest successful envelope across completed turns", () => {
  const { store, session, req } = setup();
  const first = store.beginTurn(session.id, "First", 1).turn;
  pair(store, first.id, "old", "reports");
  pair(store, first.id, "other", "design");
  store.completeTurn(first.id, { text: "Done", tokens: 1 });
  const next = store.beginTurn(session.id, "Next", 1).turn;
  const latest = pair(store, next.id, "latest", "reports");
  store.appendEvent(next.id, "skills.selected", { skills: [{ id: "skill:design" }, { id: "skill:reports" }] });
  store.completeTurn(next.id, { text: "Done", tokens: 1 });
  const restored = restoreSessionSkills(store, req);
  assert.deepEqual(restored.selected, ["skill:design", "skill:reports"]);
  assert.equal(restored.loaded.length, 2);
  assert.deepEqual(restored.loaded.find(skill => skill.name === "reports"),
    { id: "latest", name: "reports", text: latest, turnId: next.id });
  assert.deepEqual(restored.loaded.map(skill => skill.turnId), [first.id, next.id]);
});

test("catalogue bytes and loaded skills survive reopening the remembered session store", () => {
  const path = join(dirs.make(), "sessions.sqlite");
  const store = new SessionStore({ path });
  const session = store.createSession({ kind: "direct", agentId: "agent", owner: "owner" });
  assert.equal(store.freezeSkillCatalogue(session.id, "Available skills\nreports: Create reports"),
    "Available skills\nreports: Create reports");
  assert.equal(store.freezeSkillCatalogue(session.id, "Changed catalogue"), "Available skills\nreports: Create reports");
  const { turn } = store.beginTurn(session.id, "Report", 1);
  const output = pair(store, turn.id, "persisted", "reports");
  store.completeTurn(turn.id, { text: "Done", tokens: 1 });
  store.close();
  const reopened = new SessionStore({ path });
  dirs.onCleanup(() => reopened.close());
  assert.equal(reopened.freezeSkillCatalogue(session.id, "After restart"), "Available skills\nreports: Create reports");
  assert.deepEqual(restoreSessionSkills(reopened, { sessionId: session.id, agentId: "agent", principal: "owner" }).loaded,
    [{ id: "persisted", name: "reports", text: output, turnId: turn.id }]);
});

test("incognito catalogue calls use current bytes and an unknown session cannot create a snapshot", () => {
  const { store } = setup();
  const session = store.createSession({ kind: "direct", agentId: "agent", owner: "owner", memoryMode: "incognito" });
  assert.equal(store.freezeSkillCatalogue(session.id, "First"), "First");
  assert.equal(store.freezeSkillCatalogue(session.id, "Second"), "Second");
  assert.throws(() => store.freezeSkillCatalogue("missing", "Private"), { code: "not-found" });
});

test("repeated load events do not evict an earlier distinct loaded skill from session history", () => {
  const { store, session, req } = setup();
  const { turn } = store.beginTurn(session.id, "Resources", 1);
  const original = pair(store, turn.id, "original", "reports");
  for (let i = 0; i < 2100; i++) pair(store, turn.id, `repeat-${i}`, "design");
  store.completeTurn(turn.id, { text: "Done", tokens: 1 });
  const restored = restoreSessionSkills(store, req);
  assert.equal(restored.loaded.length, 2);
  assert.deepEqual(restored.loaded.find(skill => skill.name === "reports"),
    { id: "original", name: "reports", text: original, turnId: turn.id });
});

test("a malformed newer envelope cannot replace an earlier valid successful skill load", () => {
  const { store, session, req } = setup();
  const { turn } = store.beginTurn(session.id, "Resources", 1);
  const original = pair(store, turn.id, "original", "reports");
  pair(store, turn.id, "wrong-tool", "reports", JSON.stringify({ isError: false, tool: "file.read",
    value: { name: "reports", text: "Wrong tool", files: [] } }));
  pair(store, turn.id, "wrong-files", "reports", JSON.stringify({ isError: false,
    value: { name: "reports", text: "Wrong files", files: [42] } }));
  store.completeTurn(turn.id, { text: "Done", tokens: 1 });
  assert.deepEqual(restoreSessionSkills(store, req).loaded,
    [{ id: "original", name: "reports", text: original, turnId: turn.id }]);
});

test("the additive catalogue migration preserves an existing v6 session and its events", () => {
  const path = join(dirs.make(), "sessions.sqlite");
  const raw = new DatabaseSync(path);
  migrate(raw, MIGRATIONS.slice(0, 6));
  raw.prepare(`INSERT INTO sessions(id,kind,agent_id,owner,scope,created_at,updated_at)
    VALUES ('legacy','direct','agent','owner','user',1,1)`).run();
  raw.close();
  const store = new SessionStore({ path });
  dirs.onCleanup(() => store.close());
  assert.equal(store.getSession("legacy")?.owner, "owner");
  assert.equal(store.freezeSkillCatalogue("legacy", "Available skills\nreports: Create reports"),
    "Available skills\nreports: Create reports");
  assert.deepEqual(store.listEvents("legacy"), []);
});
