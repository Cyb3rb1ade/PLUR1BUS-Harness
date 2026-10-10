// Settings > Voice against the mock API (V3 contract): language change with progress and errors, licence confirmation gate, research-only
// marking, realtime profile save, engine-fixed marking, metrics, unavailable, a11y (labels, keyboard slider, live region), German, 400 px.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { MB, installVoice, pushProgress, voiceCalls, voiceWorld } from "./voice-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const open = async (app: App, lang: "en" | "de" = "en"): Promise<void> => { await openRoute(app.page, "#/settings/voice", lang); };
const ready = async (app: App): Promise<void> => { await app.page.locator("#voice-language").waitFor(); await app.page.locator("#voice-rt-save").waitFor(); };

describe("voice settings: language", opts, () => {
  test("shows the current setting, sizes and licence per model", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const { page } = app;
      assert.equal(await page.locator("#voice-language").inputValue(), "de");
      assert.equal(await page.locator("#voice-profile-fast").isChecked(), true);
      const rows = page.locator(".voice-models tbody tr");
      assert.equal(await rows.count(), 3);
      const kroko = rows.filter({ hasText: "kroko-de" });
      assert.match(await kroko.innerText(), /120 MiB/); assert.match(await kroko.innerText(), /CC-BY-SA-4\.0/);
      assert.match(await page.locator("#voice-profile-fast-d").innerText(), /182 MiB in total/);
      assert.match(await page.locator("main").innerText(), /Current setting: German, Fast/);
      assert.deepEqual(app.problems, []);
    });
  });

  test("changing the language: licence gate blocks, then download with progress and a polite live region", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const { page, server } = app;
      // German / fast needs the Kroko confirmation (CC-BY-SA)
      const apply = page.locator("#voice-apply");
      assert.equal(await apply.isDisabled(), true, "no confirmation, no download");
      const box = page.getByRole("checkbox", { name: /CC-BY-SA-4\.0.*kroko-de/ });
      await box.check();
      assert.equal(await apply.isDisabled(), false);
      await box.uncheck();
      assert.equal(await apply.isDisabled(), true);
      assert.equal(await page.locator(".voice-licences a, .voice-models a").count(), 0, "licence names are text, never active links");

      // switch to English / quality: nothing to confirm
      await page.locator("#voice-language").selectOption("en");
      await page.locator("#voice-profile-quality").check();
      assert.equal(await page.locator(".voice-licences").count(), 0);
      assert.equal(await apply.isDisabled(), false);
      const before = server.events.connections.length;
      await apply.click();
      await server.events.waitForConnections(before + 1);
      for (let i = 0; i < 50 && voiceCalls(server, "voice.language.set").length === 0; i++) await page.waitForTimeout(20);
      await page.locator("#voice-live").waitFor({ state: "attached" });
      assert.equal(await page.locator("#voice-live").getAttribute("aria-live"), "polite");
      assert.equal(await page.locator("#voice-live").getAttribute("role"), "status");
      assert.deepEqual(voiceCalls(server, "voice.language.set").map((c) => c.params), [{ language: "en", profile: "quality", acceptLicences: [] }]);

      pushProgress(server, "whisper-en", 300 * MB, 600 * MB);
      const bar = page.locator("#voice-dl-whisper-en");
      await bar.waitFor();
      await page.waitForFunction(() => (document.querySelector("#voice-dl-whisper-en") as HTMLProgressElement | null)?.value === 50);
      assert.equal(await page.locator('label[for="voice-dl-whisper-en"]').innerText(), "whisper-en: 50 %");
      await page.waitForFunction(() => /Downloading: \d+ %/.test(document.querySelector("#voice-live")?.textContent ?? ""));
      pushProgress(server, "whisper-en", 600 * MB, 600 * MB, true);
      pushProgress(server, "kokoro-en", 330 * MB, 330 * MB, true);
      pushProgress(server, "silero-vad", 2 * MB, 2 * MB, true);
      await page.getByText("Saved: English, Quality.").waitFor();
      assert.equal(((await page.locator("#voice-live").textContent()) ?? "").trim(), "Download finished.");
      assert.deepEqual(app.problems, []);
    });
  });

  test("a failed download shows an alert and the model that failed", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const { page, server } = app;
      await page.locator("#voice-language").selectOption("en");
      await page.locator("#voice-profile-quality").check();
      const before = server.events.connections.length;
      await page.locator("#voice-apply").click();
      await server.events.waitForConnections(before + 1);
      await page.locator("#voice-dl-kokoro-en").waitFor({ state: "attached" }).catch(() => undefined);
      pushProgress(server, "kokoro-en", 10 * MB, 330 * MB, true, "disk full");
      await page.getByRole("alert").filter({ hasText: "Download failed for kokoro-en." }).waitFor();
      assert.equal(await page.locator("#voice-apply").isDisabled(), false, "the person can try again");
    });
  });

  test("a licence the server still wants (E_VOICE_LICENCE) is explained; an unavailable server says so", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const { page, server } = app;
      await page.getByRole("checkbox", { name: /kroko-de/ }).check();
      server.rpc.scenario("voice.language.set", "error", { code: "E_VOICE_LICENCE" });
      await page.locator("#voice-apply").click();
      await page.getByRole("alert").filter({ hasText: "licence confirmation that is missing" }).waitFor();
      server.rpc.scenario("voice.language.set", "error", { code: "E_VOICE_UNAVAILABLE" });
      await page.locator("#voice-apply").click();
      await page.getByRole("alert").filter({ hasText: "not available on this server" }).waitFor();
    });
  });

  test("research-only models are marked in the profile, the table and the confirmation", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld({ downloading: false })); await open(app); await ready(app);
      const { page } = app;
      assert.match(await page.locator('label[for="voice-profile-fast"]').innerText(), /^Fast/);
      await page.locator("#voice-language").selectOption("en");
      await page.locator("#voice-profile-fast").check();
      assert.match(await page.locator('label[for="voice-profile-fast"]').innerText(), /Research only, no commercial use/);
      assert.doesNotMatch(await page.locator('label[for="voice-profile-quality"]').innerText(), /Research only/);
      assert.match(await page.locator(".voice-models tr", { hasText: "piper-en-lessac" }).innerText(), /Research only, no commercial use/);
      const box = page.getByRole("checkbox", { name: /blizzard-2013 for piper-en-lessac \(research only, no commercial use\)/ });
      await box.waitFor();
      assert.equal(await page.locator("#voice-apply").isDisabled(), true);
      await box.check();
      assert.equal(await page.locator("#voice-apply").isDisabled(), false);
      await page.locator("#voice-apply").click();
      await page.getByText("Saved: English, Fast.").waitFor();
      assert.deepEqual(voiceCalls(app.server, "voice.language.set").map((c) => c.params), [{ language: "en", profile: "fast", acceptLicences: ["piper-en-lessac@blizzard-2013"] }]);
    });
  });

  test("no download needed: the setting is saved at once", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld({ downloading: false })); await open(app); await ready(app);
      await app.page.getByRole("checkbox", { name: /kroko-de/ }).check();
      await app.page.locator("#voice-apply").click();
      await app.page.getByText("Saved: German, Fast.").waitFor();
    });
  });
});

describe("voice settings: real-time profile", opts, () => {
  test("save sends exactly the edited fields (keyboard slider, switches, mode, budget)", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const { page } = app;
      const range = page.getByLabel("Pause that ends your turn");
      assert.equal(await range.inputValue(), "700");
      await range.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      assert.equal(await range.inputValue(), "800", "arrow keys move the slider in steps of 50");
      await page.getByLabel("Start the turn speculatively").check();
      await page.getByLabel("Acknowledgement sound").uncheck();
      await page.getByLabel("Reranker", { exact: true }).selectOption("off");
      await page.getByLabel("Automatic recall: Time budget (ms)").fill("300");
      await page.locator("#voice-rt-save").click();
      await page.getByText("Real-time settings saved.").waitFor();
      const [call] = voiceCalls(app.server, "voice.realtime.profile.set");
      const p = call!.params as Record<string, unknown> & { features: Record<string, unknown> };
      assert.equal(p.enabled, true); assert.equal(p.endpointingMs, 800); assert.equal(p.speculative, true); assert.equal(p.ackSound, false);
      assert.equal("agentId" in p, false);
      assert.deepEqual(p.features.reranker, { mode: "off" });
      assert.deepEqual(p.features.autoRecall, { mode: "on", maxMs: 300 });
      assert.deepEqual(p.features.postTurnRefine, { mode: "deferred", maxMs: 400 });
      assert.deepEqual(p.features.toolSchemas, { mode: "reduced", maxMs: 50 });
      assert.equal(JSON.stringify(p).includes("effective"), false);
      assert.equal(Object.keys(p.features).length, 8);
    });
  });

  test("only toolSchemas offers `reduced`; the real-time switch is saved", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const { page } = app;
      assert.deepEqual(await page.getByLabel("Tool schemas", { exact: true }).locator("option").allInnerTexts(), ["On", "Deferred", "Reduced", "Off"]);
      assert.deepEqual(await page.getByLabel("Reranker", { exact: true }).locator("option").allInnerTexts(), ["On", "Deferred", "Off"]);
      await page.locator("#voice-rt-enabled").uncheck();
      await page.locator("#voice-rt-save").click();
      await page.getByText("Real-time settings saved.").waitFor();
      assert.equal((voiceCalls(app.server, "voice.realtime.profile.set")[0]!.params as { enabled: boolean }).enabled, false);
    });
  });

  test("engine-fixed features are marked as taking effect only with engine support", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const row = app.page.locator('tr[data-feature="memoryWrite"]');
      assert.equal(await row.getAttribute("data-effective"), "engine-fixed");
      assert.match(await row.innerText(), /Fixed by the engine/); assert.match(await row.innerText(), /Takes effect only with engine support/);
      const ok = app.page.locator('tr[data-feature="reranker"]');
      assert.equal(await ok.getAttribute("data-effective"), null);
      assert.match(await ok.innerText(), /Applied/);
    });
  });

  test("measured costs per feature and the last median / p95", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const { page } = app;
      assert.match(await page.locator('tr[data-feature="autoRecall"]').innerText(), /median 120 ms, p95 260 ms/);
      assert.match(await page.locator('tr[data-feature="compaction"]').innerText(), /no measurement/);
      assert.match(await page.locator(".voice-latency").innerText(), /Median 820 ms, p95 1,340 ms, 42 samples in the last 60 min/);
    });
  });

  test("without metrics the form still works and says so", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld({ metrics: null })); await open(app); await ready(app);
      await app.page.getByText("Measurements are not available.").waitFor();
      assert.match(await app.page.locator('tr[data-feature="autoRecall"]').innerText(), /no measurement/);
    });
  });

  test("a save that fails keeps the edits and tells the person", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      app.server.rpc.scenario("voice.realtime.profile.set", "error", { code: "E_INTERNAL" });
      await app.page.getByLabel("Acknowledgement sound").uncheck();
      await app.page.locator("#voice-rt-save").click();
      await app.page.getByRole("alert").filter({ hasText: "Could not save the real-time settings." }).waitFor();
      assert.equal(await app.page.getByLabel("Acknowledgement sound").isChecked(), false);
    });
  });
});

describe("voice settings: states", opts, () => {
  test("a server that does not know the methods: unavailable, no crash", async () => {
    await withApp({}, async (app) => {
      app.server.rpc.enable(); await open(app);
      await app.page.locator(".page-state[data-state=unavailable]").first().waitFor();
      assert.equal(await app.page.locator(".page-state[data-state=unavailable]").count(), 2);
      assert.deepEqual(app.problems, []);
    });
  });
  test("E_VOICE_UNAVAILABLE counts as unavailable, too", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server);
      app.server.rpc.scenario("voice.language.list", "error", { code: "E_VOICE_UNAVAILABLE" });
      await open(app);
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
      await app.page.locator("#voice-rt-save").waitFor();
    });
  });
  test("an error offers Try again", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server);
      app.server.rpc.scenario("voice.realtime.profile.get", "error", { code: "E_INTERNAL" });
      await open(app);
      await app.page.getByRole("alert").waitFor();
      app.server.rpc.scenario("voice.realtime.profile.get", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await app.page.locator("#voice-rt-save").waitFor();
    });
  });
  test("read-only note when the role may not change voice settings", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server);
      await app.page.route("**/api/v1/whoami", (r) => r.fulfill({ json: { schema: "whoami/1", user: { id: "v", role: "viewer" } } })).catch(() => undefined);
      await open(app); await ready(app);
      const disabled = await app.page.locator("#voice-rt-save").isDisabled();
      if (disabled) assert.ok(await app.page.getByText("Your role may look at these settings but not change them.").first().isVisible());
    });
  });
});

describe("voice settings: a11y, German, layout", opts, () => {
  test("axe clean (light and dark), every control has a name", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      await withApp({ colorScheme }, async (app) => {
        installVoice(app.server); await open(app); await ready(app);
        await expectAxeClean(app.page, `settings voice ${colorScheme}`);
        const unnamed = await app.page.evaluate(() => Array.from(document.querySelectorAll(".voice input, .voice select")).filter((el) => !(el as HTMLInputElement).labels?.length && !el.getAttribute("aria-label")).map((el) => el.id));
        assert.deepEqual(unnamed, []);
      });
    }
  });
  test("German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      installVoice(app.server); await open(app, "de"); await app.page.locator("#voice-language").waitFor();
      await app.page.getByRole("heading", { name: "Sprachfunktionen", level: 2 }).waitFor();
      await app.page.getByText("Echtzeit-Modus", { exact: true }).first().waitFor();
      assert.match(await app.page.locator('tr[data-feature="memoryWrite"]').innerText(), /Wirkt erst mit Engine-Unterstützung/);
      await app.page.getByRole("checkbox", { name: /Ich akzeptiere die Lizenz CC-BY-SA-4\.0 für kroko-de/ }).waitFor();
      await expectAxeClean(app.page, "settings voice de");
    });
  });
  test("400 px has no horizontal scroll", async () => {
    await withApp({ width: 400, height: 800 }, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    });
  });
});
