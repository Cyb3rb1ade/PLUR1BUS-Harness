// N-F2: only canonical tool names persist in a bounded, session-scoped, monotonic offer union.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../src/session/store.ts";
import { MIGRATIONS, migrate } from "../../src/session/migrations.ts";
import { useTempDirs } from "../composition/helpers.ts";

const dirs = useTempDirs("n-session-tool-offers-");

function setup() {
  const store = new SessionStore({ path: ":memory:" });
  dirs.onCleanup(() => store.close());
  const session = store.createSession({ kind: "direct", agentId: "agent", owner: "owner" });
  return { store, session };
}

test("tool offers form an ordered unique union and callers cannot mutate the stored set", () => {
  const { store, session } = setup();
  assert.deepEqual(store.toolOffers(session.id), []);
  store.rememberToolOffers(session.id, ["file.read", "exec.run", "file.read"]);
  store.rememberToolOffers(session.id, ["web.fetch", "exec.run", "sys.startupItems"]);
  const offered = store.toolOffers(session.id);
  assert.deepEqual(offered, ["file.read", "exec.run", "web.fetch", "sys.startupItems"]);
  offered.push("unrequested.tool");
  assert.deepEqual(store.toolOffers(session.id), ["file.read", "exec.run", "web.fetch", "sys.startupItems"]);
});

test("the retained union stops at 128 distinct names without evicting earlier offers", () => {
  const { store, session } = setup();
  const first = Array.from({ length: 127 }, (_, index) => `fixture.tool-${index}`);
  store.rememberToolOffers(session.id, first);
  store.rememberToolOffers(session.id, [first[0]!, "last.accepted", "overflow.rejected"]);
  store.rememberToolOffers(session.id, ["another.rejected"]);
  assert.deepEqual(store.toolOffers(session.id), [...first, "last.accepted"]);
});

test("invalid names refuse the entire batch before any valid name is persisted", () => {
  const { store, session } = setup();
  for (const name of ["", "Tool.upper", "tool with space", "tool/path", "tool\nname", "x".repeat(65), 42]) {
    assert.throws(() => store.rememberToolOffers(session.id, ["valid.tool", name] as string[]),
      { code: "invalid", reason: "tool-name" });
    assert.deepEqual(store.toolOffers(session.id), []);
  }
});

test("offers never cross another owner's or agent's session and missing sessions are refused", () => {
  const { store, session } = setup();
  const foreign = store.createSession({ kind: "direct", agentId: "other", owner: "other" });
  store.rememberToolOffers(session.id, ["private.lookup"]);
  store.rememberToolOffers(foreign.id, ["other.lookup"]);
  assert.deepEqual(store.toolOffers(session.id), ["private.lookup"]);
  assert.deepEqual(store.toolOffers(foreign.id), ["other.lookup"]);
  assert.throws(() => store.toolOffers("missing"), { code: "not-found" });
  assert.throws(() => store.rememberToolOffers("missing", ["private.lookup"]), { code: "not-found" });
});

test("remembered tool offers survive restart while incognito offers remain in their volatile store", () => {
  const path = join(dirs.make(), "sessions.sqlite");
  const store = new SessionStore({ path });
  const session = store.createSession({ kind: "direct", agentId: "agent", owner: "owner" });
  store.rememberToolOffers(session.id, ["file.read", "web.fetch"]);
  store.close();
  const reopened = new SessionStore({ path });
  dirs.onCleanup(() => reopened.close());
  assert.deepEqual(reopened.toolOffers(session.id), ["file.read", "web.fetch"]);
  const ephemeral = new SessionStore({ path: ":memory:" });
  const incognito = ephemeral.createSession({ kind: "direct", agentId: "agent", owner: "owner", memoryMode: "incognito" });
  ephemeral.rememberToolOffers(incognito.id, ["private.read"]);
  assert.deepEqual(ephemeral.toolOffers(incognito.id), ["private.read"]);
  assert.equal(reopened.getSession(incognito.id), null);
  ephemeral.close();
});

test("v7 sessions migrate additively and erased sessions cascade their remembered offers", () => {
  const path = join(dirs.make(), "sessions.sqlite");
  const raw = new DatabaseSync(path);
  migrate(raw, MIGRATIONS.slice(0, 7));
  raw.prepare(`INSERT INTO sessions(id,kind,agent_id,owner,scope,created_at,updated_at)
    VALUES ('legacy','direct','agent','owner','user',1,1)`).run();
  raw.close();
  const store = new SessionStore({ path });
  store.rememberToolOffers("legacy", ["file.read"]);
  assert.equal(store.getSession("legacy")?.owner, "owner");
  store.archiveSession("legacy");
  store.eraseSession("legacy", { actor: "owner", reason: "requested erasure" });
  store.close();
  const inspected = new DatabaseSync(path);
  assert.equal((inspected.prepare("SELECT COUNT(*) AS count FROM session_tool_offers").get() as { count: number }).count, 0);
  inspected.close();
});
