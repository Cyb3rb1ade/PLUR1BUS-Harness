// Step 12 (Voice) of the server hardening sweep. Already pinned elsewhere (not repeated): language list, licence gate, download with
// progress, E_VOICE_LICENCE and E_VOICE_UNAVAILABLE on apply, research-only badges, the real-time form, engine-fixed marks, metrics,
// the states, axe in light and dark, German and 400 px (voice-settings.test.ts); the per-agent form and its Reset (voice-override.test.ts);
// the pure model (voice-model.test.ts); the setup step (setup-voice.test.ts). This file adds what a wrong or hostile answer, a wrong
// error code or a switch of language could still get wrong. E_VOICE_LICENCE and E_VOICE_LICENSE are two different codes of the core.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installAgents } from "./agents-fixtures.ts";
import { MB, installVoice, profileOf, pushProgress, voiceCalls, voiceWorld } from "./voice-fixtures.ts";
import { applyProgress, draftOf, isResearchOnly, parseBudget, parseProgress, percentOf, preselectProfile, summarize, voiceErrorOf } from "../src/pages/voice/model.ts";
import { validDraft } from "../src/pages/voice/realtime.ts";
import type { VoiceLanguage, VoiceModel } from "../src/api/voice.types.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const open = async (app: App, lang: "en" | "de" = "en"): Promise<void> => { await openRoute(app.page, "#/settings/voice", lang); };
const ready = async (app: App): Promise<void> => { await app.page.locator("#voice-language").waitFor(); await app.page.locator("#voice-rt-save").waitFor(); };
const model = (modelId: string, licenceId: string, needsConfirmation = false, role: VoiceModel["role"] = "tts"): VoiceModel => ({ modelId, role, sizeBytes: 10 * MB, licenceId, needsConfirmation, installed: false });
const language = (code: string, fast: VoiceModel[] | null, quality: VoiceModel[] | null): VoiceLanguage =>
  ({ language: code, profiles: { ...(fast ? { fast: { models: fast } } : {}), ...(quality ? { quality: { models: quality } } : {}) } });
const as = <T>(v: unknown): T => v as T;

describe("voice model: licences, progress and budgets cannot be fooled", () => {
  test("a non-commercial licence is recognised however its hyphens are typed; permissive ones never are", () => {
    for (const id of ["CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-3.0", "cc by-nc 4.0", "CC‑BY‑NC‑4.0", "CC–BY–NC–4.0", "CC−BY−NC−4.0", "ＣＣ-ＢＹ-ＮＣ-4.0", "Non-Commercial", "research only", "Blizzard-2013", "  RESEARCH-ONLY  "]) assert.equal(isResearchOnly(id), true, JSON.stringify(id));
    for (const id of ["MIT", "Apache-2.0", "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "BSD-3-Clause", "ISC", "OFL-1.1", "GPL-3.0-or-later", "Unlicense", "ranch-licence", "sync-1.0", "ONC-1"]) assert.equal(isResearchOnly(id), false, id);
  });

  test("a model without a usable licence id does not take the page down", () => {
    for (const bad of [undefined, null, 5, {}, []]) assert.doesNotThrow(() => isResearchOnly(as<string>(bad)), JSON.stringify(bad));
  });

  test("a profile whose model is research-only under any spelling is never preselected", () => {
    const nc = model("tts-nc", "CC‑BY‑NC‑4.0", true); const ok = model("tts-ok", "MIT");
    assert.equal(preselectProfile(language("en", [nc], [ok])), "quality"); assert.equal(preselectProfile(language("en", [ok], [nc])), "fast");
    assert.equal(preselectProfile(language("de", [nc], [nc])), null); assert.equal(preselectProfile(language("de", [nc], null)), null);
  });

  test("download progress: negative or absurd numbers are not a progress; a bar is always 0 to 100", () => {
    assert.equal(parseProgress('{"modelId":"a","receivedBytes":-1,"totalBytes":10,"done":false}'), null);
    assert.equal(parseProgress('{"modelId":"a","receivedBytes":1,"totalBytes":-10,"done":false}'), null);
    assert.equal(parseProgress('{"modelId":"a","receivedBytes":1e999,"totalBytes":10,"done":false}'), null);
    assert.equal(parseProgress("null"), null); assert.equal(parseProgress("[]"), null); assert.equal(parseProgress('{"modelId":"","receivedBytes":1,"totalBytes":2,"done":false}'), null);
    for (const [r, t, done] of [[-5, 100, false], [Number.NaN, 100, false], [50, Number.POSITIVE_INFINITY, false], [500, 100, false], [1, 0, false], [0, 0, true]] as const) {
      const p = percentOf({ receivedBytes: r, totalBytes: t, done }); assert.ok(p >= 0 && p <= 100 && Number.isInteger(p), `${r}/${t} gave ${p}`);
    }
    const d = applyProgress({}, { modelId: "__proto__", receivedBytes: 1, totalBytes: 2, done: false }); assert.equal(Object.getPrototypeOf(d), Object.prototype); assert.equal(Object.hasOwn(d, "__proto__"), true);
    const s = summarize(["a", "b"], { a: { receivedBytes: -9, totalBytes: 10, done: false }, b: { receivedBytes: 99, totalBytes: 10, done: false } }); assert.ok(s.percent >= 0 && s.percent <= 100);
  });

  test("the budget a person types is a whole number from 0 to 60 000, or nothing; a draft outside the ranges is not sent", () => {
    for (const [raw, want] of [["", undefined], ["  ", undefined], ["abc", undefined], ["12abc", undefined], ["Infinity", undefined], ["1e999", undefined], ["-5", 0], ["0", 0], ["1.6", 2], ["70000", 60_000], ["1e3", 1000]] as const) assert.equal(parseBudget(raw), want, JSON.stringify(raw));
    const base = draftOf(profileOf()); assert.equal(validDraft(base), true);
    for (const bad of [{ endpointingMs: Number.NaN }, { endpointingMs: 199 }, { endpointingMs: 2001 }, { endpointingMs: Number.POSITIVE_INFINITY }]) assert.equal(validDraft({ ...base, ...bad }), false, JSON.stringify(bad));
    for (const maxMs of [-1, 60_001, Number.NaN]) assert.equal(validDraft({ ...base, features: { ...base.features, reranker: { mode: "on", maxMs } } }), false, String(maxMs));
  });

  test("every E_VOICE_* code is read from the places an error carries it, nothing else is", () => {
    for (const code of ["E_VOICE_LICENCE", "E_VOICE_LICENSE", "E_VOICE_BUDGET", "E_VOICE_UNAVAILABLE"]) {
      assert.equal(voiceErrorOf({ data: { error: code } }), code); assert.equal(voiceErrorOf({ errorCode: code }), code); assert.equal(voiceErrorOf({ message: code }), code);
    }
    for (const bad of [null, undefined, 5, "E_VOICE_BUDGET", {}, { data: null }, { data: { error: "E_VOICE_OTHER" } }, { data: { error: ["E_VOICE_BUDGET"] } }, { message: "an E_VOICE_BUDGET happened" }]) assert.equal(voiceErrorOf(bad), null, JSON.stringify(bad));
  });
});

const CODES = [["E_VOICE_LICENCE", /licence confirmation that is missing/], ["E_VOICE_LICENSE", /licence confirmation that is missing/], ["E_VOICE_BUDGET", /add up to more than/], ["E_VOICE_UNAVAILABLE", /not available on this server/], ["E_INTERNAL", /Could not save the language\./]] as const;

describe("voice settings: every error of the core has its own words", opts, () => {
  test("applying a language: the licence codes (both spellings), the budget, 'unavailable' and an unknown failure each say what is wrong", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld({ downloading: false })); await open(app); await ready(app);
      await app.page.getByRole("checkbox", { name: /kroko-de/ }).check();
      for (const [code, text] of CODES) {
        app.server.rpc.scenario("voice.language.set", "error", { code: code as never }); await app.page.locator("#voice-apply").click();
        await app.page.getByRole("alert").filter({ hasText: text }).waitFor();
      }
      assert.deepEqual(app.problems, []);
    });
  });

  test("saving the real-time profile: 'budget too large' and 'unavailable' are named, anything else is the general failure", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      await app.page.getByLabel("Acknowledgement sound").uncheck();
      for (const [code, text] of [["E_VOICE_BUDGET", /add up to more than/], ["E_VOICE_UNAVAILABLE", /not available on this server/], ["E_VOICE_LICENSE", /Could not save the real-time settings\./], ["E_INTERNAL", /Could not save the real-time settings\./]] as const) {
        app.server.rpc.scenario("voice.realtime.profile.set", "error", { code: code as never }); await app.page.locator("#voice-rt-save").click();
        await app.page.getByRole("alert").filter({ hasText: text }).waitFor();
        assert.equal(await app.page.getByLabel("Acknowledgement sound").isChecked(), false, "the edit was lost with the failure");
      }
    });
  });

  test("saving an agent's override: the budget and 'unavailable' are named there too", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server); installVoice(app.server); await openRoute(app.page, "#/agents/main"); await app.page.locator("#voice-ag-endpointing").waitFor();
      await app.page.locator("#voice-ag-endpointing").focus(); await app.page.keyboard.press("ArrowRight");
      for (const [code, text] of [["E_VOICE_BUDGET", /add up to more than/], ["E_VOICE_UNAVAILABLE", /not available on this server/]] as const) {
        app.server.rpc.scenario("voice.realtime.profile.set", "error", { code: code as never }); await app.page.locator("#voice-ag-save").click();
        await app.page.getByRole("alert").filter({ hasText: text }).waitFor();
      }
      assert.equal(await app.page.locator("#voice-ag-endpointing").inputValue(), "750", "the edit was lost with the failure");
    });
  });

  test("German: the new budget text exists and the page is clean with an error showing (360 px, dark)", async () => {
    await withApp({ width: 360, colorScheme: "dark", locale: "de-DE" }, async (app) => {
      installVoice(app.server, voiceWorld({ downloading: false })); await open(app, "de"); await app.page.locator("#voice-language").waitFor();
      await app.page.locator("#voice-language").selectOption("fr"); await app.page.getByRole("checkbox", { name: /piper-fr-siwis/ }).check();
      app.server.rpc.scenario("voice.language.set", "error", { code: "E_VOICE_BUDGET" as never }); await app.page.locator("#voice-apply").click();
      await app.page.getByRole("alert").filter({ hasText: /Zeitbudgets/ }).waitFor(); await expectAxeClean(app.page, "voice de dark 360 error");
      const overflow = await app.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert.ok(overflow <= 0, `${overflow}px of horizontal scrolling`);
    });
  });
});

describe("voice settings: licences and the switch of language", opts, () => {
  test("a licence ticked for one language does not carry over to another; the apply button follows", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      const apply = app.page.locator("#voice-apply"); const box = app.page.getByRole("checkbox", { name: /kroko-de/ });
      await box.check(); assert.equal(await apply.isDisabled(), false);
      await app.page.locator("#voice-language").selectOption("en"); await app.page.locator("#voice-language").selectOption("de");
      await app.page.locator("#voice-profile-fast").check(); assert.equal(await box.isChecked(), false, "a confirmation survived a change of language"); assert.equal(await apply.isDisabled(), true);
      await box.check(); await app.page.locator("#voice-profile-quality").check(); await app.page.locator("#voice-profile-fast").check(); assert.equal(await box.isChecked(), false, "a confirmation survived a change of profile"); assert.equal(await apply.isDisabled(), true);
    });
  });

  test("a non-commercial model says so before the download, and exactly the model@licence ticked is sent", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld({ downloading: false })); await open(app); await ready(app);
      await app.page.locator("#voice-language").selectOption("fr");
      const box = app.page.getByRole("checkbox", { name: /CC-BY-NC-4\.0 for piper-fr-siwis \(research only, no commercial use\)/ }); await box.waitFor();
      assert.match(await app.page.locator('label[for="voice-profile-fast"]').innerText(), /Research only, no commercial use/);
      assert.equal(await app.page.locator("#voice-apply").isDisabled(), true); assert.equal(await app.page.locator("main a[href]").filter({ hasText: /NC|licen/i }).count(), 0);
      await box.check(); await app.page.locator("#voice-apply").click(); await app.page.getByText("Saved: French, Fast.").waitFor();
      assert.deepEqual(voiceCalls(app.server, "voice.language.set").map((c) => c.params), [{ language: "fr", profile: "fast", acceptLicences: ["piper-fr-siwis@CC-BY-NC-4.0"] }]);
    });
  });

  test("a non-commercial licence with typographic hyphens is badged and asks for the research-only confirmation, too", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld({ languages: [language("en", [model("tts-sneaky", "CC‑BY‑NC‑4.0", true)], [model("tts-open", "MIT")])], current: { language: "en", profile: "quality" }, downloading: false }));
      await open(app); await ready(app); await app.page.locator("#voice-profile-fast").check();
      assert.match(await app.page.locator('label[for="voice-profile-fast"]').innerText(), /Research only, no commercial use/);
      assert.match(await app.page.locator(".voice-models tr", { hasText: "tts-sneaky" }).innerText(), /Research only, no commercial use/);
      await app.page.getByRole("checkbox", { name: /for tts-sneaky \(research only, no commercial use\)/ }).waitFor();
    });
  });

  test("with no setting saved yet, a non-commercial profile is never the one that is already chosen", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server, voiceWorld({ languages: [language("en", [model("tts-nc", "CC-BY-NC-4.0", true)], null)], downloading: false }));
      app.server.rpc.scenario("voice.language.get", "error", { code: "E_INTERNAL" }); await open(app); await app.page.locator("#voice-language").waitFor();
      assert.equal(await app.page.locator("#voice-language").inputValue(), "en"); assert.equal(await app.page.locator('input[name="voice-profile"]:checked').count(), 0, "a research-only profile was chosen for the person");
      assert.equal(await app.page.locator("#voice-apply").isDisabled(), true);
    });
  });

  test("with no setting saved, the English quality profile is chosen and the research-only fast one is not", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); app.server.rpc.scenario("voice.language.get", "error", { code: "E_INTERNAL" }); await open(app); await app.page.locator("#voice-language").waitFor();
      assert.equal(await app.page.locator("#voice-language").inputValue(), "en"); assert.equal(await app.page.locator("#voice-profile-quality").isChecked(), true); assert.equal(await app.page.locator("#voice-profile-fast").isChecked(), false);
    });
  });

  test("read-only role: nothing can be ticked, picked or applied", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      assert.equal(await app.page.locator("#voice-apply").isDisabled(), true); assert.equal(await app.page.getByRole("checkbox", { name: /kroko-de/ }).isDisabled(), true); assert.equal(await app.page.locator("#voice-language").isDisabled(), true);
      assert.equal(await app.page.locator("#voice-rt-save").isDisabled(), true);
    });
  });
});

describe("voice settings: download progress from a stream the page does not control", opts, () => {
  test("a negative or oversized count, another model's event and a repeated event never draw a bar outside 0 to 100", async () => {
    await withApp({}, async (app) => {
      installVoice(app.server); await open(app); await ready(app);
      await app.page.locator("#voice-language").selectOption("en"); await app.page.locator("#voice-profile-quality").check();
      const before = app.server.events.connections.length; await app.page.locator("#voice-apply").click(); await app.server.events.waitForConnections(before + 1);
      const bar = app.page.locator("#voice-dl-whisper-en"); await bar.waitFor();
      pushProgress(app.server, "whisper-en", 300 * MB, 600 * MB); await app.page.waitForFunction(() => (document.querySelector("#voice-dl-whisper-en") as HTMLProgressElement | null)?.value === 50);
      pushProgress(app.server, "whisper-en", -5, 600 * MB); pushProgress(app.server, "someone-else", 600 * MB, 600 * MB, true); pushProgress(app.server, "whisper-en", 300 * MB, 600 * MB); await app.page.waitForTimeout(300);
      assert.equal(await bar.evaluate((e) => (e as HTMLProgressElement).value), 50, "a bad event moved the bar"); assert.equal(await app.page.locator(".voice-progress").count(), 3, "the page shows only the models of this profile");
      pushProgress(app.server, "whisper-en", 900 * MB, 600 * MB); await app.page.waitForTimeout(300);
      assert.equal(await bar.evaluate((e) => (e as HTMLProgressElement).value), 100);
      assert.deepEqual(app.problems, []);
    });
  });
});

describe("voice: the agent override", opts, () => {
  test("Reset removes the override (voice.agent.override.clear) instead of writing the global values for the agent", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server); const w = installVoice(app.server); w.agents["main"] = profileOf({ endpointingMs: 1200 });
      await openRoute(app.page, "#/agents/main"); await app.page.locator("#voice-ag-endpointing").waitFor();
      await app.page.locator("#voice-ag-reset").click(); await app.page.getByText("This agent uses the global values again.").waitFor();
      assert.equal(voiceCalls(app.server, "voice.agent.override.clear").length, 1, "Reset did not call voice.agent.override.clear");
    });
  });
});
