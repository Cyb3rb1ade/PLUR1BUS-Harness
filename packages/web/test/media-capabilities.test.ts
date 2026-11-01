// MM-3a: server capability flags describe the status model; encoder installation is a separate fact.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { installAgents } from "./agents-fixtures.ts";
import { overrideChanges, overrideOf } from "../src/pages/media-search/override.ts";
import { seedConfig } from "./settings-config-fixtures.ts";
import { seedMedia, status } from "./media-search-fixtures.ts";
import { FRESH_MEMORY, seed, toMemoryStep, next, stepHeading } from "./setup-fixtures.ts";
import { MEDIA_EMBEDDING_DEFAULTS } from "../src/pages/media-search/contract.ts";
import { initial, load, save } from "../src/pages/setup/model.ts";
import { changesOf, draftOf, mediaSetupDefaults, mediaSetupChanges } from "../src/pages/media-search/model.ts";

before(setup);
after(teardown);

test("setup proposes manual backfill and saved explicit auto and manual answers survive reload", () => {
  assert.equal(mediaSetupDefaults().backfill, "manual");
  for (const backfill of ["auto", "manual"] as const) {
    const state = initial();
    state.answers.media.backfill = backfill;
    save(state);
    assert.equal(load().answers.media.backfill, backfill);
  }
});

test("editing an exposed field preserves unexposed q8 and token settings and explicit backfill", () => {
  for (const backfill of ["auto", "manual"] as const) {
    const config = { memory: { mediaEmbedding: { backfill, image: { softTokens: 140 }, video: { softTokens: 70 }, dtypes: { "linux-x64": { text: "q8", vision: "q8", audio: "q8" } } } } };
    const before = draftOf(config);
    assert.equal(before.backfill, backfill);
    const after = draftOf(config);
    after.video.segmentSec = 45;
    assert.deepEqual(changesOf(before, after), [{ key: "memory.mediaEmbedding.video.segmentSec", value: 45 }]);
  }
});

describe("MM-3a capability display", { skip: browserSkip }, () => {
  for (const lang of ["en", "de"] as const) {
    test(`${lang}: all returned flags are displayed even when no encoder is installed`, async () => {
      await withApp({ locale: lang === "de" ? "de-DE" : "en-US" }, async (app) => {
        seedConfig(app.server.rpc, {}); seedMedia(app.server.rpc);
        app.server.rpc.handle("media.index.status", () => ({ ...status(), capabilities: { text: true, image: true, audio: true, video: true }, encoders: [] }));
        await openRoute(app.page, "#/settings/memory", lang);
        const card = app.page.locator(".media-status");
        await card.waitFor();
        assert.match(await card.innerText(), lang === "en" ? /This model understands: Text, Image, Audio, Video/ : /Dieses Modell versteht: Text, Bild, Audio, Video/);
        assert.match(await card.innerText(), lang === "en" ? /Encoder installation: Unknown/ : /Encoder-Installation: Unbekannt/);
      });
    });
  }

  test("false flags stay absent despite the familiar model name; encoder states stay separate", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, {}); seedMedia(app.server.rpc);
      app.server.rpc.handle("media.index.status", () => ({ ...status(), capabilities: { text: true, image: false, audio: false, video: false }, encoders: [
        { role: "text", dtype: "q8", state: "ready", downloadBytes: 123456 },
        { role: "vision", dtype: "q8", state: "not-installed" },
        { role: "audio", dtype: "q8", state: "unavailable" },
      ] }));
      await openRoute(app.page, "#/settings/memory");
      const facts = app.page.locator(".media-status .model-capabilities");
      await facts.waitFor();
      const support = await facts.locator(".model-support").innerText();
      assert.equal(support, "This model understands: Text");
      const text = await facts.innerText();
      assert.match(text, /Text · q8: Ready/);
      assert.match(text, /Vision · q8: Not installed/);
      assert.match(text, /Audio · q8: Unavailable/);
      assert.match(text, /123,456 bytes/);
      assert.match(text, /Download size: Unknown/);
    });
  });

  test("old status omits support claims and keeps encoder readiness unknown", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, {}); seedMedia(app.server.rpc);
      await openRoute(app.page, "#/settings/memory");
      await app.page.locator(".media-status").waitFor();
      assert.equal(await app.page.locator(".media-status .model-support").count(), 0);
      assert.match(await app.page.locator(".media-status").innerText(), /Encoder installation: Unknown/);
    });
  });

  test("Memory setup scopes capabilities to the status model and proposes manual when no backend choice is returned", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      app.server.rpc.handle("model.memory.status", () => ({ ...FRESH_MEMORY, capabilities: { text: true, image: false, audio: false, video: false }, encoders: [] }));
      await openRoute(app.page, "#/setup"); await toMemoryStep(app);
      const facts = app.page.locator(".model-capabilities");
      await facts.waitFor();
      assert.match(await facts.innerText(), /intfloat\/multilingual-e5-small/);
      assert.match(await facts.innerText(), /This model understands: Text/);
      assert.equal(await app.page.locator("#setup-backfill-manual").isChecked(), true);
      assert.match(await app.page.locator(".setup-media").innerText(), /Time per photo: Unknown/);
    });
  });

  test("audio is bounded at 30 seconds while a 45-second video segment can be saved", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, {}); seedMedia(app.server.rpc);
      await openRoute(app.page, "#/settings/memory");
      const audio = app.page.locator("#cfg-memory-mediaEmbedding-audio-segmentSec");
      await audio.waitFor();
      assert.equal(await audio.getAttribute("max"), "30");
      const video = app.page.locator("#cfg-memory-mediaEmbedding-video-segmentSec");
      assert.notEqual(await video.getAttribute("max"), "30");
      await video.fill("45");
      await app.page.getByRole("button", { name: "Save indexes" }).click();
      await app.page.getByText("Saved.").first().waitFor();
      const call = app.server.rpc.calls.find((c) => c.method === "config.set");
      assert.deepEqual((call?.params as { changes: unknown[] }).changes, [{ key: "memory.mediaEmbedding.video.segmentSec", value: 45 }]);
    });
  });
});

test("without a reported backend choice setup explicitly writes the manual schema default", () => {
  const { backfill } = mediaSetupDefaults();
  assert.equal(backfill, "manual");
  assert.equal(MEDIA_EMBEDDING_DEFAULTS.backfill, "manual");
  assert.deepEqual(mediaSetupChanges(mediaSetupDefaults(), "egemma2"), [{ key: "memory.mediaEmbedding.backfill", value: "manual" }]);
});


test("agent audio overrides read, change and clear only their own segment key", () => {
  const config = { agents: { main: { memory: { mediaEmbedding: { audio: { segmentSec: 12 }, video: { softTokens: 70 } } } } } };
  const before = overrideOf(config, "main");
  assert.equal(before.audioSegmentSec, 12);
  assert.equal(overrideOf({}, "main").audioSegmentSec, null);
  assert.deepEqual(overrideChanges("main", before, { ...before, audioSegmentSec: null }), [
    { key: "agents.main.memory.mediaEmbedding.audio.segmentSec", value: null },
  ]);
});

test("agent audio segments inherit and save at most 30 seconds", { skip: browserSkip }, async () => {
  await withApp({}, async (app) => {
    seedConfig(app.server.rpc, {}); installAgents(app.server);
    await openRoute(app.page, "#/agents/main");
    const audio = app.page.locator("#override-audio-segmentSec");
    await audio.waitFor();
    assert.equal(await audio.inputValue(), "");
    assert.equal(await audio.getAttribute("placeholder"), "30");
    assert.equal(await audio.getAttribute("max"), "30");
    await audio.fill("12");
    await app.page.getByRole("button", { name: "Save for this agent" }).click();
    await app.page.getByText("Saved for this agent.").waitFor();
    const call = app.server.rpc.calls.find((c) => c.method === "config.set");
    assert.deepEqual((call?.params as { changes: unknown[] }).changes, [{ key: "agents.main.memory.mediaEmbedding.audio.segmentSec", value: 12 }]);
  });
});


for (const backfill of ["auto", "manual"] as const) {
  test(`fresh-browser setup preserves backend ${backfill} backfill`, { skip: browserSkip }, async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      app.server.rpc.handle("config.get", (params) => ({
        value: (params as { key?: string })?.key === "memory.mediaEmbedding" ? { backfill } : {}, revision: "r1",
      }));
      await openRoute(app.page, "#/setup"); await toMemoryStep(app);
      await app.page.locator(`#setup-backfill-${backfill}:checked`).waitFor();
      assert.equal(await app.page.locator(`#setup-backfill-${backfill}`).isChecked(), true);
      await next(app.page);
      await stepHeading(app.page, "Name & persona").waitFor();
      const changes = app.server.rpc.calls.filter((c) => c.method === "config.set")
        .flatMap((c) => (c.params as { changes: { key: string }[] }).changes);
      assert.equal(changes.some((c) => c.key === "memory.mediaEmbedding.backfill"), false);
    });
  });
}

test("a person's new backfill selection overrides the existing backend choice", { skip: browserSkip }, async () => {
  await withApp({}, async (app) => {
    seed(app.server.rpc);
    app.server.rpc.handle("config.get", () => ({ value: { backfill: "manual" }, revision: "r1" }));
    await openRoute(app.page, "#/setup"); await toMemoryStep(app);
    await app.page.locator("#setup-backfill-auto").check();
    await next(app.page);
    await stepHeading(app.page, "Name & persona").waitFor();
    const changes = app.server.rpc.calls.filter((c) => c.method === "config.set")
      .flatMap((c) => (c.params as { changes: { key: string; value: unknown }[] }).changes);
    assert.deepEqual(changes.find((c) => c.key === "memory.mediaEmbedding.backfill"),
      { key: "memory.mediaEmbedding.backfill", value: "auto" });
  });
});

test("Next preserves backend backfill even before the step's config read returns", { skip: browserSkip }, async () => {
  await withApp({}, async (app) => {
    seed(app.server.rpc);
    let release = (): void => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    app.server.rpc.handle("config.get", async (params) => {
      if ((params as { key?: string })?.key !== "memory.mediaEmbedding") return { value: {}, revision: "r1" };
      if (++reads === 1) await pending;
      return { value: { backfill: "auto" }, revision: "r1" };
    });
    try {
      await openRoute(app.page, "#/setup"); await toMemoryStep(app);
      await next(app.page);
      await stepHeading(app.page, "Name & persona").waitFor();
      assert.equal(reads, 2);
      const changes = app.server.rpc.calls.filter((c) => c.method === "config.set")
        .flatMap((c) => (c.params as { changes: { key: string }[] }).changes);
      assert.equal(changes.some((c) => c.key === "memory.mediaEmbedding.backfill"), false);
    } finally { release(); }
  });
});
