// Mode B: TypeScript writes a private promotion receipt, then reads Rust receipts through ChatPromotion.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChatPromotion } from "../../packages/core/src/collab/chat-promotion.ts";
import { createCollab } from "../../packages/core/src/collab/service.ts";
import { SessionStore } from "../../packages/core/src/session/store.ts";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";

const [op, directory] = process.argv.slice(2);
assert.ok(directory);
const me = { kind: "person", role: "owner", userId: "owner" } as const;
const collab = createCollab({ path: ":memory:", clock: () => 1000, newId: prefix => prefix + "_1" });
const sessions = new SessionStore({ path: ":memory:", clock: () => 1000, newId: prefix => prefix + "_1" });
const project = collab.createProject(me, { name: "Existing project" });
const session = sessions.createSession({ kind: "direct", owner: deriveUserPrincipal(me.userId), agentId: "sender" });
const ts = "promotion-ts.sqlite";
const rust = "promotion-rust.sqlite";
const open = (name: string) => new ChatPromotion({
  path: join(directory, name), sessions: () => ({ forSession: () => ({ store: sessions }) } as never),
  collab, now: () => 1000, audit() {},
});
const schema = (name: string) => {
  const db = new DatabaseSync(join(directory, name));
  try {
    return { definition: db.prepare("SELECT sql FROM sqlite_master WHERE name='chat_promotions'").get(),
      version: db.prepare("PRAGMA user_version").get(), integrity: db.prepare("PRAGMA integrity_check").get() };
  } finally { db.close(); }
};
try {
  if (op === "prepare") {
    const promo = open(ts);
    try {
      const preview = promo.preview(me, { sessionId: session.id, target: { kind: "project", projectId: project.id } });
      promo.commit(me, preview.previewId);
    } finally { promo.close(); }
  } else if (op === "verify") {
    for (const [name, count] of [[ts, 2], [rust, 1]] as const) {
      const promo = open(name);
      try {
        const links = promo.links(me, session.id).links;
        assert.equal(links.length, count);
        assert.ok(links.every(link => link.projectId === project.id && link.selection === "none" && link.cardId === null));
      } finally { promo.close(); }
    }
    assert.deepEqual(schema(ts), schema(rust));
  } else { throw new Error("expected prepare or verify"); }
} finally { collab.close(); sessions.close(); }
