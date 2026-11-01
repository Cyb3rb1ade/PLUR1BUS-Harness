// MM-3a: server capability flags describe the status model; encoder installation is a separate fact.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { defaults, type HarnessConfig } from "@plur1bus/config-schema";
import { validateMediaChanges } from "../../core/src/media-search/validate.ts";
import { installAgents } from "./agents-fixtures.ts";
import { overrideChanges, overrideOf } from "../src/pages/media-search/override.ts";
import { seedConfig } from "./settings-config-fixtures.ts";
import { seedMedia, status } from "./media-search-fixtures.ts";
import { FRESH_MEMORY, seed, toMemoryStep, next, stepHeading } from "./setup-fixtures.ts";
import { MEDIA_EMBEDDING_DEFAULTS } from "../src/pages/media-search/contract.ts";
import { rpcError } from "./mock-rpc.ts";
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


test("clearing an agent audio segment replaces its parent while preserving other audio settings", () => {
  const config = { agents: { main: { memory: { mediaEmbedding: { audio: { segmentSec: 12, maxSeconds: 90 }, video: { softTokens: 70 } } } } } };
  const before = overrideOf(config, "main");
  assert.equal(before.audioSegmentSec, 12);
  assert.equal(overrideOf({}, "main").audioSegmentSec, null);
  assert.deepEqual(overrideChanges("main", before, { ...before, audioSegmentSec: null }), [
    { key: "agents.main.memory.mediaEmbedding.audio", value: { maxSeconds: 90 } },
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


test("clearing an audio override locks saving through refresh and recovers from failures", { skip: browserSkip }, async () => {
  await withApp({}, async (app) => {
    const config = defaults();
    config.memory.mediaEmbedding.audio.segmentSec = 18;
    config.agents.main = { memory: { mediaEmbedding: { audio: { segmentSec: 12, maxSeconds: 90 } } } };
    installAgents(app.server);
    const fixture = seedConfig(app.server.rpc, config as unknown as Record<string, unknown>);
    const refreshStarted = Promise.withResolvers<void>(), refresh = Promise.withResolvers<void>();
    const nextEditSaved = Promise.withResolvers<void>();
    let holdRefresh = true, rejectWrite = false, writes = 0;
    app.server.rpc.handle("config.get", async (params) => {
      const key = (params as { key?: string } | undefined)?.key;
      if (key === undefined && fixture.revision > 1 && holdRefresh) {
        refreshStarted.resolve();
        await refresh.promise;
        throw rpcError("E_STORAGE", "reload unavailable");
      }
      const value = key === undefined ? fixture.config : key.split(".").reduce<unknown>((o, part) =>
        o && typeof o === "object" ? (o as Record<string, unknown>)[part] : undefined, fixture.config);
      return { value, revision: `r${fixture.revision}` };
    }, { write: false });
    app.server.rpc.handle("config.set", async (params) => {
      const p = params as { changes: { key: string; value: unknown }[]; ifRevision: string };
      writes++;
      if (rejectWrite) { rejectWrite = false; throw rpcError("E_STORAGE", "write unavailable"); }
      await validateMediaChanges(fixture.config as unknown as HarnessConfig, p.changes);
      assert.equal(p.ifRevision, `r${fixture.revision}`);
      if (writes === 1) {
        assert.deepEqual(p.changes, [{ key: "agents.main.memory.mediaEmbedding.audio", value: { maxSeconds: 90 } }]);
        config.agents.main!.memory!.mediaEmbedding!.audio = p.changes[0]!.value as { maxSeconds: number };
        fixture.revision++;
      } else {
        assert.deepEqual(p.changes, [{ key: "agents.main.memory.mediaEmbedding.audio.segmentSec", value: writes === 3 ? 14 : 15 }]);
        config.agents.main!.memory!.mediaEmbedding!.audio!.segmentSec = p.changes[0]!.value as number;
        // A successful refresh may retain its revision: the form must still accept a later edit.
        if (writes === 4) nextEditSaved.resolve();
      }
      return { applied: true, dryRun: false, changed: p.changes.map((c) => c.key), restart: {}, revision: `r${fixture.revision}` };
    });
    await openRoute(app.page, "#/agents/main");
    const audio = app.page.locator("#override-audio-segmentSec");
    await audio.waitFor();
    assert.equal(await audio.inputValue(), "12");
    await audio.fill("");
    const saveButton = app.page.getByRole("button", { name: "Save for this agent" });
    try {
      await saveButton.click();
      await refreshStarted.promise;
      await app.page.getByText("Saved for this agent.").waitFor();
      assert.equal(await audio.inputValue(), "");
      assert.equal(await audio.getAttribute("placeholder"), "18");
      assert.deepEqual(config.agents.main!.memory!.mediaEmbedding!.audio, { maxSeconds: 90 });
      assert.equal({ ...config.memory.mediaEmbedding.audio, ...config.agents.main!.memory!.mediaEmbedding!.audio }.segmentSec, 18);
      assert.equal(await saveButton.isDisabled(), true, "saving stays locked while the committed config reload is pending");
      assert.equal(await saveButton.evaluate((element) => {
        let clicks = 0;
        element.addEventListener("click", () => { clicks++; });
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
        return clicks;
      }), 0, "even immediate repeated DOM clicks cannot dispatch another write");
      assert.equal(writes, 1);

      holdRefresh = false;
      refresh.resolve();
      await app.page.getByRole("alert").getByRole("button", { name: "Try again", exact: true }).click();
      await audio.waitFor();
      assert.equal(await saveButton.isDisabled(), true);
      rejectWrite = true;
      await audio.fill("14");
      await saveButton.click();
      await app.page.getByText("The override could not be saved.", { exact: true }).waitFor();
      assert.equal(await saveButton.isEnabled(), true, "a rejected write is retryable");
      assert.equal(writes, 2);
      await saveButton.click();
      await app.page.getByText("Saved for this agent.", { exact: true }).waitFor();
      await app.page.locator('.media-override[aria-busy="false"]').waitFor();
      await audio.fill("15");
      await saveButton.click();
      await nextEditSaved.promise;
      assert.equal(writes, 4, "refreshing an unchanged revision unlocks a later edit");
    } finally {
      holdRefresh = false;
      refresh.resolve();
    }
  });
});
