// Agents > detail > Voice override (V3 contract): per-agent real-time profile, inherited / overridden markers,
// saving with agentId, resetting to inherited global values, and unavailable state.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installAgents } from "./agents-fixtures.ts";
import { installVoice, profileOf, voiceCalls } from "./voice-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const open = async (app: App, id = "main", lang: "en" | "de" = "en"): Promise<void> => {
  await openRoute(app.page, `#/agents/${id}`, lang);
};

describe("voice: agent override", opts, () => {
  test("shows inherited values, marks changes as overridden, and saves with agentId", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server);
      installVoice(app.server);
      await open(app, "main");
      const { page } = app;
      await page.getByRole("heading", { name: "Voice (real-time) for this agent", level: 3 }).waitFor();
      await page.locator("#voice-ag-endpointing").waitFor();

      // All fields inherit the global profile initially
      const inheritBadges = page.locator(".voice-rt").getByText("inherited");
      assert.ok((await inheritBadges.count()) > 0);

      // Modify endpointing on the slider
      const slider = page.locator("#voice-ag-endpointing");
      assert.equal(await slider.inputValue(), "700");
      await slider.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      assert.equal(await slider.inputValue(), "800");

      // That field is now marked overridden
      const overriddenBadges = page.locator(".voice-rt").getByText("overridden");
      assert.equal(await overriddenBadges.count(), 1);

      // Save
      const saveBtn = page.locator("#voice-ag-save");
      assert.equal(await saveBtn.isDisabled(), false);
      await saveBtn.click();
      await page.getByText("Real-time settings saved.").waitFor();

      // Verify the RPC call has agentId: "main" and endpointingMs: 800
      const calls = voiceCalls(app.server, "voice.realtime.profile.set");
      assert.ok(calls.length >= 1);
      const last = calls.at(-1)!.params as { agentId?: string; endpointingMs?: number };
      assert.equal(last.agentId, "main");
      assert.equal(last.endpointingMs, 800);
      assert.deepEqual(app.problems, []);
    });
  });

  test("reset removes the agent's override (voice.agent.override.clear) and shows the global values", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server);
      const w = installVoice(app.server);
      // Give agent 'main' an existing override
      w.agents["main"] = profileOf({ endpointingMs: 1200, speculative: true });
      await open(app, "main");
      const { page } = app;
      await page.getByRole("heading", { name: "Voice (real-time) for this agent", level: 3 }).waitFor();
      await page.locator("#voice-ag-endpointing").waitFor();
      assert.equal(await page.locator("#voice-ag-endpointing").inputValue(), "1200");

      const resetBtn = page.locator("#voice-ag-reset");
      assert.equal(await resetBtn.isDisabled(), false);
      await resetBtn.click();
      await page.getByText("This agent uses the global values again.").waitFor();

      const clears = voiceCalls(app.server, "voice.agent.override.clear");
      assert.equal(clears.length, 1);
      assert.deepEqual(clears[0]!.params, { agentId: "main" });
      assert.equal(voiceCalls(app.server, "voice.realtime.profile.set").length, 0, "Reset must not write the global values for the agent");
      assert.equal(await page.locator("#voice-ag-endpointing").inputValue(), "700", "the form shows the global value again");
    });
  });

  test("unavailable when voice RPCs are missing without crashing", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server);
      app.server.rpc.enable();
      await open(app, "main");
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
      assert.deepEqual(app.problems, []);
    });
  });

  test("a11y and German translation", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      installAgents(app.server);
      installVoice(app.server);
      await open(app, "main", "de");
      const { page } = app;
      await page.getByRole("heading", { name: "Sprache (Echtzeit) für diesen Agenten", level: 3 }).waitFor();
      await page.locator(".voice-rt").getByText("geerbt").first().waitFor();
      await expectAxeClean(page, "voice agent override de");
    });
  });
});
