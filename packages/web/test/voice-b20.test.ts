// b20 audit: Voice. A research-only licence is always confirmed by the person, a finished download is applied once, and the real-time
// form does not take edits while a save is in flight (the answer would overwrite them).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { installAgents } from "./agents-fixtures.ts";
import { LANGUAGES, MB, installVoice, profileOf, pushProgress, voiceCalls, voiceWorld } from "./voice-fixtures.ts";
import { acceptList, allConfirmed, confirmationsNeeded } from "../src/pages/voice/model.ts";
import type { VoiceLanguage, VoiceModel } from "../src/api/voice.types.ts";
import { gate } from "./models-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const m = (modelId: string, licenceId: string, needsConfirmation: boolean): VoiceModel => ({ modelId, role: "tts", sizeBytes: MB, licenceId, needsConfirmation, installed: false });

describe("voice: research-only licences are never skipped", () => {
  test("a research-only model needs the confirmation even if the server did not flag it", () => {
    const lessac = m("piper-en-lessac", "blizzard-2013", false), ok = m("kokoro", "Apache-2.0", false);
    assert.deepEqual(confirmationsNeeded([lessac, ok]).map((x) => x.modelId), ["piper-en-lessac"]);
    assert.equal(allConfirmed([lessac, ok], new Set()), false);
    assert.deepEqual(acceptList([lessac, ok], new Set(["piper-en-lessac@blizzard-2013"])), ["piper-en-lessac@blizzard-2013"]);
    assert.equal(confirmationsNeeded([{ ...lessac, installed: true }]).length, 0, "an installed model was confirmed when it was fetched");
  });

  test("the panel keeps Apply disabled until it is ticked", opts, async () => {
    await withApp({}, async (app) => {
      const languages: VoiceLanguage[] = LANGUAGES().map((l) => l.language !== "en" ? l
        : { ...l, profiles: { ...l.profiles, fast: { models: l.profiles.fast!.models.map((x) => x.modelId === "piper-en-lessac" ? { ...x, needsConfirmation: false } : x) } } });
      installVoice(app.server, voiceWorld({ languages, downloading: false }));
      await openRoute(app.page, "#/settings/voice");
      await app.page.locator("#voice-language").waitFor();
      await app.page.locator("#voice-language").selectOption("en");
      await app.page.locator("#voice-profile-fast").check();
      assert.equal(await app.page.locator("#voice-apply").isDisabled(), true, "Apply is enabled without the research-only confirmation");
      await app.page.getByRole("checkbox", { name: /blizzard-2013 for piper-en-lessac/ }).check();
      await app.page.locator("#voice-apply").click();
      await app.page.getByText("Saved: English, Fast.").waitFor();
      assert.deepEqual(voiceCalls(app.server, "voice.language.set").map((c) => c.params), [{ language: "en", profile: "fast", acceptLicences: ["piper-en-lessac@blizzard-2013"] }]);
    });
  });
});

describe("voice: races", opts, () => {
  test("a download that finishes before the answer of voice.language.set is applied once", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld());
      const g = gate();
      app.server.rpc.handle("voice.language.set", async () => {
        for (const id of ["zipformer-en", "piper-en-lessac", "silero-vad"]) pushProgress(app.server, id, MB, MB, true);
        await g.wait;
        return { ok: true, downloading: true };
      });
      await openRoute(app.page, "#/settings/voice");
      await app.page.locator("#voice-language").waitFor();
      await app.page.locator("#voice-language").selectOption("en");
      await app.page.locator("#voice-profile-fast").check();
      await app.page.getByRole("checkbox", { name: /blizzard-2013 for piper-en-lessac/ }).check();
      // "Saved" renders before the refresh effect runs. Wait for that first refresh, so the late answer is the only remaining trigger.
      const refreshed = app.page.waitForResponse(r => r.url().endsWith("/rpc") && r.request().postDataJSON()?.method === "voice.language.list");
      const answered = app.page.waitForResponse(r => r.url().endsWith("/rpc") && r.request().postDataJSON()?.method === "voice.language.set");
      await app.page.locator("#voice-apply").click();
      await app.page.getByText("Saved: English, Fast.").waitFor();
      await (await refreshed).finished();
      const before = voiceCalls(app.server, "voice.language.list").length;
      assert.equal(before, 2, "the initial load and one completion refresh are required");
      g.open();
      await (await answered).finished();
      await app.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(voiceCalls(app.server, "voice.language.list").length, before, "the answer applied the same result a second time");
    });
  });

  test("the global real-time form takes no edits while a save is in flight", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld());
      const g = gate();
      await openRoute(app.page, "#/settings/voice");
      await app.page.locator("#voice-rt-save").waitFor();
      app.server.rpc.handle("voice.realtime.profile.set", async (p: unknown) => { await g.wait; return profileOf({ ...(p as object) }); });
      await app.page.locator("#voice-rt-speculative").check();
      await app.page.locator("#voice-rt-save").click();
      await app.page.waitForFunction(() => (document.querySelector("#voice-rt-save") as HTMLButtonElement).disabled);
      assert.equal(await app.page.locator("#voice-rt-ack").isDisabled(), true, "an edit now would be overwritten by the answer");
      g.open();
      await app.page.getByText("Saved.", { exact: false }).first().waitFor();
    });
  });

  test("the per-agent form takes no edits while a save is in flight", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server); installVoice(app.server, voiceWorld());
      const g = gate();
      await openRoute(app.page, "#/agents/main");
      await app.page.locator("#voice-ag-speculative").waitFor();
      app.server.rpc.handle("voice.realtime.profile.set", async (p: unknown) => { await g.wait; return profileOf({ ...(p as object) }); });
      await app.page.locator("#voice-ag-speculative").check();
      await app.page.locator("#voice-ag-save").click();
      await app.page.waitForFunction(() => (document.querySelector("#voice-ag-save") as HTMLButtonElement).disabled);
      assert.equal(await app.page.locator("#voice-ag-ack").isDisabled(), true, "an edit now would be overwritten by the answer");
      g.open();
    });
  });
});
