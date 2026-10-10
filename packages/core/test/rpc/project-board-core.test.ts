import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("running core advertises board methods, validates actors, delivers events and persists across restart", { timeout: 15000 }, async () => {
  const home = tempDir("p1b-board-core-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  let projectId = "", cardId = "";
  for (const first of [true, false]) {
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    const client = await connect({ address: core.address, token: core.token });
    try {
      if (first) {
        const project = await client.call<any>("project.create", { name: "Board" }); projectId = project.id;
        const columns = await client.call<any>("project.column.list", { projectId });
        assert.equal(columns.columns.length, 4);
        let resolveEvent!: (event: any) => void;
        const received = new Promise<any>(resolve => { resolveEvent = resolve; });
        client.onNotification((method, params) => { if (method === "project.card.changed") resolveEvent(params); });
        await client.call("events.subscribe", { names: ["project.card.changed", "project.column.changed"] });
        const card = await client.call<any>("project.card.create", { projectId, columnId: columns.columns[0].id, title: "Persistent" }); cardId = card.id;
        const event = await received; assert.equal(event.projectId, projectId); assert.equal(event.cardId, cardId);
        await assert.rejects(client.call("project.card.comment.add", { projectId, cardId, text: "x", author: { kind: "agent", id: "bernd" } }), (e: any) => e.error === "E_INVALID_PARAMS");
        await client.call("project.card.comment.add", { projectId, cardId, text: "Saved" });
        await client.call("project.column.update", { projectId, columnId: columns.columns[0].id, wipLimit: 1 });
        await assert.rejects(client.call("project.card.create", { projectId, columnId: columns.columns[0].id, title: "Overflow" }), (e: any) => e.error === "E_PROJECT_WIP_LIMIT" && e.code === -32000);
      } else {
        const card = await client.call<any>("project.card.get", { projectId, cardId }); assert.equal(card.title, "Persistent");
        const comments = await client.call<any>("project.card.comment.list", { projectId, cardId }); assert.equal(comments.items[0].text, "Saved");
        assert.equal((await client.call<any>("project.card.list", { projectId })).cards.length, 1);
      }
    } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
  }
});
