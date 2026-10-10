// First-run wizard Voice step (V3 contract): system language preselected, profile preselection (no research-only
// voice for English, Kokoro suggested, German Thorsten + Kroko CC-BY-SA gate), download with progress, skippable,
// and summary reflection.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { next, seed, skip, stepHeading, toSwitchboard } from "./setup-fixtures.ts";
import { MB, installVoice, pushProgress, voiceCalls } from "./voice-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function toVoice(app: App): Promise<void> {
  const { page } = app;
  await toSwitchboard(app);
  await skip(page);
  await stepHeading(page, /Memory/).waitFor();
  await next(page);
  await stepHeading(page, /Language for voice features/).waitFor();
}

describe("setup wizard: voice step", opts, () => {
  test("English: en is preselected, quality (Kokoro) is preselected, fast (piper-en-lessac research) is NOT preselected", async () => {
    await withApp({ locale: "en-US" }, async (app) => {
      seed(app.server);
      await openRoute(app.page, "#/setup");
      await toVoice(app);
      const { page } = app;

      // Language should be English
      assert.equal(await page.locator("#voice-language").inputValue(), "en");

      // Quality profile should be selected (Kokoro voice)
      assert.equal(await page.locator("#voice-profile-quality").isChecked(), true);
      // Fast profile has piper-en-lessac (research only) and must NOT be preselected
      assert.equal(await page.locator("#voice-profile-fast").isChecked(), false);

      // Models of quality profile shown
      assert.match(await page.locator(".voice-models").innerText(), /kokoro-en/);
      assert.match(await page.locator(".voice-models").innerText(), /whisper-en/);

      // Suggestion hint visible
      await page.getByText("For English we suggest the quality profile (Kokoro voice).").waitFor();

      // Step is skippable
      const skipBtn = page.getByRole("button", { name: "Skip this step" });
      assert.equal(await skipBtn.isVisible(), true);
      await skipBtn.click();
      await stepHeading(page, /Backups/).waitFor();

      assert.deepEqual(app.problems, []);
    });
  });

  test("German: de preselected, fast has Thorsten + Kroko with CC-BY-SA confirmation, download flow, reflected in summary", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app.server);
      await openRoute(app.page, "#/setup", "de");
      const { page, server } = app;

      // Navigate through account -> persona -> model -> switchboard -> memory -> voice
      await stepHeading(page, "Dein Konto").waitFor();
      await next(page);
      await stepHeading(page, "Name & Persona").waitFor();
      await page.getByLabel("Anzeigename").fill("Hal");
      await next(page);
      await stepHeading(page, /Hauptmodell/).waitFor();
      await page.getByLabel("Chat-Modell").selectOption("anthropic/claude-x");
      await next(page);
      await stepHeading(page, /Schaltzentrale/).waitFor();
      await skip(page);
      await stepHeading(page, /Gedächtnis/).waitFor();
      await next(page);
      await stepHeading(page, /Sprache für Sprachfunktionen/).waitFor();

      // German should be selected
      assert.equal(await page.locator("#voice-language").inputValue(), "de");
      // Fast profile should be selected
      assert.equal(await page.locator("#voice-profile-fast").isChecked(), true);

      // Thorsten + Kroko displayed
      const modelsText = await page.locator(".voice-models").innerText();
      assert.match(modelsText, /kroko-de/);
      assert.match(modelsText, /piper-de-thorsten/);

      // Confirmation for Kroko (CC-BY-SA) is required
      const applyBtn = page.locator("#voice-apply");
      assert.equal(await applyBtn.isDisabled(), true);

      const box = page.getByRole("checkbox", { name: /CC-BY-SA-4\.0.*kroko-de/ });
      await box.check();
      assert.equal(await applyBtn.isDisabled(), false);

      // Start download
      const beforeConn = server.events.connections.length;
      await applyBtn.click();
      await server.events.waitForConnections(beforeConn + 1);
      for (let i = 0; i < 50 && voiceCalls(server, "voice.language.set").length === 0; i++) await page.waitForTimeout(20);

      // Push progress events
      pushProgress(server, "kroko-de", 60 * MB, 120 * MB);
      pushProgress(server, "kroko-de", 120 * MB, 120 * MB, true);
      pushProgress(server, "piper-de-thorsten", 60 * MB, 60 * MB, true);
      pushProgress(server, "silero-vad", 2 * MB, 2 * MB, true);

      await page.getByText("Gespeichert: Deutsch, Schnell.").waitFor();

      // Advance to next step (Backups)
      await next(page);
      await stepHeading(page, /Backups/).waitFor();
      await page.getByRole("button", { name: /Backup erstellen/ }).click();
      await page.getByText(/Backup erstellt/).waitFor();
      await next(page);
      await stepHeading(page, /Import/).waitFor();
      await skip(page, "Überspringen und beenden");
      await stepHeading(page, "Zusammenfassung der Einrichtung").waitFor();

      // Summary should show the configured voice language
      const summaryText = (await page.locator(".setup-summary").textContent()) ?? "";
      assert.match(summaryText, /Sprache für Sprachfunktionen\s*erledigt/);
      assert.match(summaryText, /Sprache für Sprachfunktionen de, Profil fast/);
    });
  });

  test("a11y on the voice setup step", async () => {
    await withApp({ locale: "en-US" }, async (app) => {
      seed(app.server);
      await openRoute(app.page, "#/setup");
      await toVoice(app);
      await expectAxeClean(app.page, "setup voice step");
    });
  });
});
