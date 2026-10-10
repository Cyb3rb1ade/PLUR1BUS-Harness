// Media search in the browser, against the mock RPC: the Memory settings panel (edit, save with the exact keys, suggestions,
// status card with pause, resume and re-index, budget pause, unavailable, E_MEDIA_* on save), the setup step (defaults write
// nothing, changed modalities and media-off write their keys), the Media view search (text, kinds, find similar, hits with
// segment and jump, caption edit, empty and unavailable states, E_MEDIA_* on search) and the agent override.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seedConfig } from "./settings-config-fixtures.ts";
import { seedMedia, status } from "./media-search-fixtures.ts";
import { seed as seedSetup, toSwitchboard, skip, next, stepHeading } from "./setup-fixtures.ts";
import { installAgents, world } from "./agents-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const open = (app: App, hash: string): Promise<void> => openRoute(app.page, hash);
const sets = (app: App): { params: { changes: { key: string; value: unknown }[]; ifRevision?: string } }[] =>
  app.server.rpc.calls.filter((c) => c.method === "config.set") as never;

// A fresh object per test: the config mock writes into the objects it is given, so a shared constant would leak between tests.
const memCfg = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ memory: { embedding: { provider: "egemma2" } }, ...extra });

describe("media search: Settings → Memory", opts, () => {
  test("text and media index side by side, the status card, and no write before saving", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, memCfg()); seedMedia(app.server.rpc);
      await open(app, "#/settings/memory");
      await app.page.getByRole("heading", { name: "Indexes", level: 3 }).waitFor();
      assert.equal(await app.page.locator(".media-areas .setup-area").count(), 2, "text and media index side by side");
      assert.equal(await app.page.locator("#cfg-memory-mediaEmbedding-provider").count(), 1);
      assert.equal(await app.page.locator("#cfg-memory-mediaEmbedding-enabled").isChecked(), true);
      const card = app.page.locator(".media-status");
      await card.getByRole("heading", { name: "Index status" }).waitFor();
      assert.match(await card.innerText(), /Indexed: 120/);
      assert.match(await card.innerText(), /Pending: 14/);
      assert.match(await card.innerText(), /Failed: 2/);
      assert.match(await card.innerText(), /Unsupported: 1/);
      assert.match(await card.innerText(), /40 of 135/);
      assert.equal(sets(app).length, 0);
    });
  });

  test("editing a video option and saving sends exactly that key, with the revision", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, memCfg()); seedMedia(app.server.rpc);
      await open(app, "#/settings/memory");
      await app.page.locator("#cfg-memory-mediaEmbedding-video-segmentSec").waitFor();
      await app.page.locator("#cfg-memory-mediaEmbedding-video-segmentSec").fill("20");
      await app.page.getByRole("button", { name: "Save indexes" }).click();
      await app.page.getByText("Saved.").first().waitFor();
      const [c] = sets(app);
      assert.deepEqual(c?.params.changes, [{ key: "memory.mediaEmbedding.video.segmentSec", value: 20 }]);
      assert.equal(c?.params.ifRevision, "r1");
    });
  });

  test("a suggestion only fills the modalities until saved; then the modalities key is sent", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, memCfg()); seedMedia(app.server.rpc);
      await open(app, "#/settings/memory");
      await app.page.getByRole("button", { name: "Images only" }).waitFor();
      await app.page.getByRole("button", { name: "Images only" }).click();
      assert.equal(await app.page.locator("#cfg-memory-mediaEmbedding-modality-video").isChecked(), false);
      assert.equal(await app.page.locator("#cfg-memory-mediaEmbedding-modality-image").isChecked(), true);
      assert.equal(sets(app).length, 0, "a suggestion writes nothing");
      await app.page.getByRole("button", { name: "Save indexes" }).click();
      await app.page.getByText("Saved.").first().waitFor();
      assert.deepEqual(sets(app)[0]?.params.changes, [{ key: "memory.mediaEmbedding.modalities", value: ["image"] }]);
    });
  });

  test("a non-commercial licence error from the server is shown in words, not as a crash", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, memCfg()); seedMedia(app.server.rpc);
      app.server.rpc.scenario("config.set", "error", { code: "E_MEDIA_LICENSE", message: "licence", reason: "licence" });
      await open(app, "#/settings/memory");
      await app.page.locator("#cfg-memory-mediaEmbedding-video-segmentSec").waitFor();
      await app.page.locator("#cfg-memory-mediaEmbedding-video-segmentSec").fill("20");
      await app.page.getByRole("button", { name: "Save indexes" }).click();
      await app.page.getByText("needs its licence confirmed").waitFor();
    });
  });

  test("pause, resume and re-index with a confirmation dialog", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, memCfg()); const f = seedMedia(app.server.rpc);
      await open(app, "#/settings/memory");
      await app.page.getByRole("button", { name: "Pause", exact: true }).click();
      await app.page.getByRole("button", { name: "Resume", exact: true }).waitFor();
      assert.match(await app.page.locator(".media-status").innerText(), /Paused by you\./);
      await app.page.getByRole("button", { name: "Resume", exact: true }).click();
      await app.page.getByRole("button", { name: "Pause", exact: true }).waitFor();
      await app.page.getByRole("button", { name: "Re-index media" }).click();
      await app.page.getByRole("heading", { name: "Re-index all media?" }).waitFor();
      assert.equal(f.actions.includes("reindex"), false, "nothing happens before the dialog is confirmed");
      await app.page.getByRole("button", { name: "Re-index", exact: true }).click();
      await app.page.getByRole("heading", { name: "Re-index all media?" }).waitFor({ state: "detached" });
      assert.deepEqual(f.actions, ["pause", "resume", "reindex"]);
    });
  });

  test("a budget pause is explained in words", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, memCfg());
      seedMedia(app.server.rpc, { status: status({ backfill: { state: "paused", done: 40, total: 135, pausedReason: "budget" } }) });
      await open(app, "#/settings/memory");
      await app.page.locator(".media-status").waitFor();
      assert.match(await app.page.locator(".media-status").innerText(), /usage budget is used up/);
    });
  });

  test("without the media index method the panel shows unavailable, not an error", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, memCfg());
      await open(app, "#/settings/memory");
      await app.page.getByText("The engine has no media index yet.").waitFor();
      assert.equal(await app.page.locator(".media-status").count(), 0);
    });
  });
});

describe("media search: setup step", opts, () => {
  test("the defaults are preselected and sending the step writes no media key", async () => {
    await withApp({}, async (app) => {
      seedSetup(app.server.rpc); await open(app, "#/setup");
      await toSwitchboard(app); await skip(app.page);
      await stepHeading(app.page, /Memory/).waitFor();
      assert.equal(await app.page.locator("#setup-media-enabled").isChecked(), true);
      assert.equal(await app.page.locator("#setup-media-provider").inputValue(), "egemma2");
      for (const m of ["image", "video", "audio"]) assert.equal(await app.page.locator(`#setup-modality-${m}`).isChecked(), true, m);
      assert.equal(await app.page.locator("#setup-caption-local").isChecked(), true, "captioning is local when embedding is local");
      await next(app.page);
      await skip(app.page);
      await stepHeading(app.page, /Backups/).waitFor();
      // The persona and model steps write before this one, so the memory step's write is the last config.set.
      const memoryWrite = app.server.rpc.calls.filter((c) => c.method === "config.set").map((c) => (c.params as { changes: { key: string }[] }).changes).at(-1) ?? [];
      assert.deepEqual(memoryWrite.map((x) => x.key), ["embedding.useClass", "modelRoles.rerank"]);
      assert.equal(memoryWrite.some((x) => x.key.startsWith("memory.mediaEmbedding")), false);
    });
  });

  test("dropping a modality writes its list; switching media off writes enabled=false", async () => {
    await withApp({}, async (app) => {
      seedSetup(app.server.rpc); await open(app, "#/setup");
      await toSwitchboard(app); await skip(app.page);
      await stepHeading(app.page, /Memory/).waitFor();
      await app.page.locator("#setup-modality-video").uncheck();
      await next(app.page);
      await skip(app.page);
      await stepHeading(app.page, /Backups/).waitFor();
      const changes = app.server.rpc.calls.filter((c) => c.method === "config.set").flatMap((c) => (c.params as { changes: { key: string; value: unknown }[] }).changes);
      assert.deepEqual(changes.find((x) => x.key === "memory.mediaEmbedding.modalities"), { key: "memory.mediaEmbedding.modalities", value: ["image", "audio"] });
    });
  });

  test("switching media off hides its options and writes enabled=false", async () => {
    await withApp({}, async (app) => {
      seedSetup(app.server.rpc); await open(app, "#/setup");
      await toSwitchboard(app); await skip(app.page);
      await stepHeading(app.page, /Memory/).waitFor();
      await app.page.locator("#setup-media-enabled").uncheck();
      assert.equal(await app.page.locator("#setup-modality-video").count(), 0);
      await next(app.page);
      await skip(app.page);
      await stepHeading(app.page, /Backups/).waitFor();
      const changes = app.server.rpc.calls.filter((c) => c.method === "config.set").flatMap((c) => (c.params as { changes: { key: string; value: unknown }[] }).changes);
      assert.deepEqual(changes.find((x) => x.key === "memory.mediaEmbedding.enabled"), { key: "memory.mediaEmbedding.enabled", value: false });
    });
  });
});

describe("media search: Media view", opts, () => {
  test("text search with all kinds, scores, captions and the segment of a video hit", async () => {
    await withApp({}, async (app) => {
      const f = seedMedia(app.server.rpc);
      await open(app, "#/media");
      await app.page.getByLabel("Describe what you are looking for").fill("forest");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByText("3 results").waitFor();
      const text = await app.page.locator(".media-hits").innerText();
      assert.match(text, /Score 0\.91/);
      assert.match(text, /Caption: a forest path at dusk/);
      assert.match(text, /Segment 0:20–0:30/);
      assert.deepEqual(f.searches[0], { text: "forest", limit: 20 });
    });
  });

  test("the kind filter narrows the search and is sent", async () => {
    await withApp({}, async (app) => {
      const f = seedMedia(app.server.rpc);
      await open(app, "#/media");
      await app.page.getByLabel("Describe what you are looking for").fill("rain");
      await app.page.getByLabel("Videos").uncheck();
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByText("2 results").waitFor();
      assert.deepEqual(f.searches[0], { text: "rain", limit: 20, kinds: ["image", "audio"] });
    });
  });

  test("a jump to an audio segment starts the player at its start", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc);
      await open(app, "#/media");
      await app.page.getByLabel("Describe what you are looking for").fill("rain");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByRole("button", { name: "Play from 0:12" }).click();
      const audio = app.page.locator("audio");
      await audio.waitFor();
      assert.match((await audio.getAttribute("src")) ?? "", /#t=12$/);
      assert.equal(await audio.getAttribute("data-start"), "12");
    });
  });

  test("find similar on a medium searches by likeMediaId and sends no text", async () => {
    await withApp({}, async (app) => {
      const f = seedMedia(app.server.rpc);
      app.server.rpc.handle("media.output.list", () => ({ outputs: [{ id: "med-image-1", prompt: "a red bridge", agentId: "main", metadata: { adapter: "local" }, createdAt: "2026-10-10T10:00:00Z", files: 1, kind: "image", mimeType: "image/png" }] }), { write: false });
      await open(app, "#/media");
      await app.page.getByRole("button", { name: "Find similar" }).first().click();
      await app.page.getByRole("status").filter({ hasText: "Similar to med-image-1" }).waitFor();
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByText("2 results").waitFor();
      assert.deepEqual(f.searches[0], { likeMediaId: "med-image-1", limit: 20 });
    });
  });

  test("a caption is edited and saved with media.caption.set", async () => {
    await withApp({}, async (app) => {
      const f = seedMedia(app.server.rpc);
      await open(app, "#/media");
      await app.page.getByLabel("Describe what you are looking for").fill("forest");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByText("3 results").waitFor();
      await app.page.getByRole("button", { name: "Edit caption" }).first().click();
      await app.page.getByLabel("Caption", { exact: true }).fill("a path in the woods");
      await app.page.getByRole("button", { name: "Save caption" }).click();
      await app.page.getByText("a path in the woods").first().waitFor();
      assert.deepEqual(f.captions[0], { mediaId: "med-video-1", text: "a path in the woods" });
    });
  });

  test("an empty query asks for a description and sends nothing", async () => {
    await withApp({}, async (app) => {
      const f = seedMedia(app.server.rpc);
      await open(app, "#/media");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByText("Enter a description or pick a medium").waitFor();
      assert.equal(f.searches.length, 0);
    });
  });

  test("media search switched off shows the explanation", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc, { status: { enabled: false } });
      await open(app, "#/media");
      await app.page.getByText("Media search is switched off.").waitFor();
    });
  });

  test("backfill running says not everything is searchable yet", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc);
      await open(app, "#/media");
      await app.page.getByText("Indexing is running (40 of 135). Not everything is searchable yet.").waitFor();
    });
  });

  test("without the media index method the search says unavailable", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc, { noStatus: true });
      await open(app, "#/media");
      await app.page.getByText("This engine has no media index, so media search is not available.").waitFor();
    });
  });

  test("a refused search shows the E_MEDIA_* text", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc, { searchError: "E_MEDIA_CAPABILITY" });
      await open(app, "#/media");
      await app.page.getByLabel("Describe what you are looking for").fill("forest");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByText("cannot handle this kind of media").waitFor();
    });
  });
});

describe("media search: agent override", opts, () => {
  test("an agent's override shows the inherited values and saves only the changed field", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, memCfg({ agents: { main: { memory: { mediaEmbedding: { provider: "egemma2" } } } } }));
      installAgents(app.server);
      await open(app, "#/agents/main");
      await app.page.getByRole("heading", { name: "Media index for this agent", level: 2 }).waitFor();
      await app.page.getByLabel("Caption source").selectOption("user-only");
      await app.page.getByRole("button", { name: "Save for this agent" }).click();
      await app.page.getByText("Saved for this agent.").waitFor();
      const c = app.server.rpc.calls.filter((x) => x.method === "config.set")[0] as unknown as { params: { changes: { key: string; value: unknown }[] } };
      assert.deepEqual(c.params.changes, [{ key: "agents.main.memory.mediaEmbedding.caption.source", value: "user-only" }]);
    });
  });
});
