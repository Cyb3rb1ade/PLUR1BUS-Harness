/** CLI-1 is additive on independent main v9; the controller reserves v11 and orders/renumbers migrations at merge. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { MIGRATIONS } from "../../src/session/migrations.ts";
import { SessionStore } from "../../src/session/store.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("the coding migration adds immutable bindings without rewriting any v9 message or event bytes", () => {
  const path = join(tempDir("code-migration-"), "sessions.sqlite");
  const db = new DatabaseSync(path);
  for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
  db.exec("PRAGMA user_version=9");
  db.prepare(
    "INSERT INTO sessions(id,kind,agent_id,owner,scope,title,memory_mode,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run("s", "direct", "worker", "owner", "user", "Original", "remember", 0, 1, 1);
  db.prepare("INSERT INTO messages(id,session_id,seq,role,text,tokens,created_at) VALUES (?,?,?,?,?,?,?)").run(
    "m",
    "s",
    1,
    "user",
    "unchanged\r\n  🧩 \u0000 bytes",
    8,
    1,
  );
  db.prepare("INSERT INTO events(session_id,seq,type,data,at) VALUES (?,?,?,?,?)").run(
    "s",
    1,
    "delta",
    '{  "text" : "untouched\\r\\n"  }',
    1,
  );
  const snapshot = () => ({
    messages: db.prepare("SELECT * FROM messages").all(),
    events: db.prepare("SELECT * FROM events").all(),
  });
  const before = snapshot();
  const store = new SessionStore({ path });
  try {
    assert.deepEqual(snapshot(), before);
    store.bindWorktree({ sessionId: "s", root: "/fixture/repo", projectId: null, cardId: null, createdBy: "owner" });
    assert.equal(store.worktree("s")?.root, "/fixture/repo");
    assert.throws(
      () => db.prepare("UPDATE session_worktrees SET root='/elsewhere' WHERE session_id='s'").run(),
      /immutable/i,
    );
    assert.deepEqual(snapshot(), before);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
  } finally {
    store.close();
    db.close();
  }
});
