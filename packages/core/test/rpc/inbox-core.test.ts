import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { LOCAL_OWNER } from "../../src/rbac/guard.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("running core: legacy break-glass notices reach the inbox once, read state survives a restart, inbox.changed reaches the only subscriber", { timeout: 20000 }, async () => {
  const home = tempDir("p1b-inbox-core-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  mkdirSync(layout(home).state, { recursive: true });
  const seed = new AdminStore({ path: join(layout(home).state, "admin.sqlite"), ownerId: LOCAL_OWNER.userId });
  seed.notice({ kind: "granted", userId: LOCAL_OWNER.userId, grantId: "g-legacy", holderUserId: "someone", reason: "reason stays out of the inbox", expiresAt: 4_000_000_000_000 });
  seed.close();
  for (const first of [true, false]) {
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    const client = await connect({ address: core.address, token: core.token });
    try {
      const list = await client.call<any>("inbox.list", {});
      assert.equal(list.entries.length, 1, "migrated exactly once, also after the second start");
      assert.equal(list.entries[0].kind, "breakglass");
      assert.equal(list.entries[0].ref.objectId, "g-legacy");
      assert.ok(!JSON.stringify(list).includes("reason stays out"));
      const count = await client.call<any>("inbox.count", {});
      if (first) {
        assert.equal(count.unread.breakglass, 1);
        let resolveEvent!: (e: any) => void;
        const received = new Promise<any>(r => { resolveEvent = r; });
        client.onNotification((m, p) => { if (m === "inbox.changed") resolveEvent(p); });
        await client.call("events.subscribe", { names: ["inbox.changed"] });
        assert.equal((await client.call<any>("inbox.markRead", { all: true })).changed, 1);
        assert.deepEqual(await received, { change: "read", kinds: ["breakglass"] });
      } else {
        assert.equal(count.unread.breakglass, 0, "read state persisted");
        assert.equal(count.total, 1);
        await assert.rejects(client.call("inbox.list", { cursor: "!!" }), (e: any) => e.error === "E_INBOX_CURSOR");
        assert.equal((await client.call<any>("inbox.dismiss", { ids: [list.entries[0].id] })).changed, 1);
        assert.equal((await client.call<any>("inbox.count", {})).total, 0);
      }
    } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
  }
});

test("running core uses config retention and merges each test override independently", { timeout: 30000 }, async () => {
  const { InboxStore } = await import("../../src/inbox/store.ts");
  const DAY = 86_400_000;
  const now = Date.now();
  for (const [override, noticeCount, expected] of [
    [undefined, 11, 10], [{ maxEntries: 12 }, 11, 11],
    [undefined, 1, 1], [{ maxAgeDays: 4 }, 1, 2],
  ] as const) {
    const home = tempDir("p1b-inbox-retention-");
    const cfg = defaults(); cfg.inbox.retention = { days: 1, maxEntries: 10 };
    cfg.agents.bernd = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
    writeFileSync(layout(home).configPath, JSON.stringify(cfg));
    mkdirSync(layout(home).state, { recursive: true });
    const store = new InboxStore({ path: join(layout(home).state, "inbox.sqlite"), clock: () => now - 3 * DAY });
    store.publish({ userId: LOCAL_OWNER.userId, kind: "system", severity: "info", titleKey: "inbox.test.old", dedupeKey: "old" });
    store.close();
    const seed = new AdminStore({ path: join(layout(home).state, "admin.sqlite"), ownerId: LOCAL_OWNER.userId });
    // A new notice triggers retention at startup; eleven notices also exercise the entry cap.
    for (let i = 0; i < noticeCount; i++) seed.notice({ kind: "granted", userId: LOCAL_OWNER.userId, grantId: `g-${i}`, holderUserId: "someone", reason: "test", expiresAt: now + DAY });
    seed.close();
    const core = createCore({ home, clock: () => now, testInternals: flatTestInternals(), ...(override ? { inbox: override } : {}) });
    await core.start();
    const client = await connect({ address: core.address, token: core.token });
    try {
      const list = await client.call<any>("inbox.list", {});
      assert.equal(list.entries.length, expected);
      assert.equal(list.entries.some((e: any) => e.kind === "system"), override !== undefined && "maxAgeDays" in override);
    } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
  }
});
