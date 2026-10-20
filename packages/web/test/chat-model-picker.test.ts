// Chat head model and reasoning dropdowns against the mock backend (test/chat-fixtures.ts): only offered profiles,
// locked ones visible but disabled with the reason, only the model's own levels, the change is a CSRF write with the
// shown revision, a quiet note lands in the transcript, keyboard works, axe clean, de/en, 400 px without overflow.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { withChat, type FakeChat } from "./chat-fixtures.ts";
import { browserSkip, setup, teardown } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const seed = (c: FakeChat): void => { c.seed({ id: "ses_1", title: "Hello world", messages: [["user", "Q"], ["assistant", "A"]] }); };
const sets = (c: FakeChat) => c.server.rpc.calls.filter((x) => x.method === "chat.model.set");
const optionTexts = (page: Page, name: string) => page.getByRole("combobox", { name }).locator("option").evaluateAll((os) => os.map((o) => `${(o as HTMLOptionElement).value}|${(o as HTMLOptionElement).disabled ? "x" : ""}|${o.textContent}`));

describe("chat: model and reasoning", opts, () => {
  test("offers the profiles and only the model's own levels; a change is a write with the revision and leaves a note", async () => {
    await withChat({ route: "#/chat/ses_1", seed: (c) => { seed(c); c.models = [...c.models, { name: "cloudy", displayName: "Cloud Big", provider: "example", model: "big", local: false, selectable: false, disabledReason: "local-only", reasoning: { kind: "effort", levels: ["low", "high"], source: "table" } }]; } }, async ({ page, chat, problems }) => {
      const model = page.getByRole("combobox", { name: "Model", exact: true });
      await model.waitFor();
      assert.equal(await model.inputValue(), "default", "a chat without its own choice shows the default profile");
      assert.deepEqual(await optionTexts(page, "Model"), ["default||Example Chat", "deep||Example Thinker", "local||Example Local (local)", "cloudy|x|Cloud Big: locked, only local models are allowed"]);
      assert.deepEqual(await optionTexts(page, "Reasoning"), ["default||Default (provider)", "low||Low", "medium||Medium", "high||High"]);
      await expectAxeClean(page, "chat model picker");

      await page.getByRole("combobox", { name: "Reasoning" }).selectOption("high");
      await page.getByText("Applies from the next reply.", { exact: false }).waitFor();
      assert.deepEqual(sets(chat).map((c) => c.params), [{ sessionId: "ses_1", profile: "default", reasoning: "high", expectedRevision: 0 }]);
      assert.notEqual(sets(chat)[0]?.csrf, null, "the switch carries a CSRF token");
      await page.getByText("A higher level bills more output tokens per reply.", { exact: false }).waitFor();
      await page.getByRole("log").getByText("Model changed: Example Chat · Reasoning: High").waitFor();

      // Switching to the thinking model keeps the level; its options show the token budget per level.
      await model.selectOption("deep");
      await page.getByRole("log").getByText("Model changed: Example Thinker · Reasoning: High").waitFor();
      assert.deepEqual(sets(chat).at(-1)?.params, { sessionId: "ses_1", profile: "deep", reasoning: "high", expectedRevision: 1 });
      assert.deepEqual(await optionTexts(page, "Reasoning"), ["default||Default (provider)", "off||Off", "low||Low (about 3,840 tokens)", "medium||Medium (about 7,936 tokens)", "high||High (about 15,872 tokens)", "xhigh||Extra high (about 32,000 tokens)"]);
      await page.getByText("Thinking can add up to about 15,872 output tokens per reply.", { exact: false }).waitFor();
      assert.deepEqual(problems, []);
    });
  });

  test("a stored level the model lacks stays visible with what it becomes; a model without control says so", async () => {
    await withChat({ route: "#/chat/ses_1", seed: (c) => { seed(c); c.modelChoice.set("ses_1", { profile: "default", reasoning: "xhigh", revision: 4 }); } }, async ({ page }) => {
      const reasoning = page.getByRole("combobox", { name: "Reasoning" });
      await reasoning.waitFor();
      assert.equal(await reasoning.inputValue(), "xhigh");
      assert.ok((await optionTexts(page, "Reasoning")).includes("xhigh|x|Extra high (uses High)"));
      await page.getByText("Example Chat does not offer Extra high; it uses High.").waitFor();
      await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("local");
      await page.getByText("The reasoning levels of Example Local are not known; the provider decides.", { exact: false }).waitFor();
    });
  });

  test("keyboard only: focus the select, jump to a level with End; a stale revision reloads and says so", async () => {
    await withChat({ route: "#/chat/ses_1", seed }, async ({ page, chat }) => {
      const reasoning = page.getByRole("combobox", { name: "Reasoning" });
      await reasoning.waitFor();
      chat.modelChoice.set("ses_1", { profile: "default", reasoning: "low", revision: 7 }); // changed elsewhere after load
      await reasoning.focus();
      // Not ArrowDown: on macOS Chromium it pops the native menu open instead of changing a closed select (so no change event
      // and the test timed out on macOS runners), while Home/End change the value without a popup on every platform.
      await page.keyboard.press("End");
      await page.getByRole("alert").filter({ hasText: "The model choice was changed elsewhere" }).waitFor();
      assert.equal(sets(chat)[0]?.params && (sets(chat)[0]!.params as { expectedRevision: number }).expectedRevision, 0);
      await page.waitForFunction(() => (document.querySelectorAll(".chat-model select")[1] as HTMLSelectElement | undefined)?.value === "low");
      assert.equal(await reasoning.inputValue(), "low", "after the reload the current state is shown");
    });
  });

  test("disabled while a reply runs", async () => {
    await withChat({ route: "#/chat/ses_1", seed }, async ({ page, chat }) => {
      await page.getByRole("combobox", { name: "Reasoning" }).waitFor();
      await page.getByRole("textbox", { name: "Message to bernd" }).fill("go");
      await page.getByRole("textbox", { name: "Message to bernd" }).press("Enter");
      await page.getByText("Wait until the reply is finished, then switch.").waitFor();
      assert.equal(await page.getByRole("combobox", { name: "Reasoning" }).isDisabled(), true);
      assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).isDisabled(), true);
      chat.complete("ses_1");
      await page.waitForFunction(() => !(document.querySelector(".chat-model select") as HTMLSelectElement | null)?.disabled);
    });
  });

  test("German at 400 px: labels translated, both selects fit without horizontal scroll", async () => {
    await withChat({ route: "#/chat/ses_1", seed, width: 400, height: 800, locale: "de-DE" }, async ({ page }) => {
      const model = page.getByRole("combobox", { name: "Modell", exact: true });
      await model.waitFor();
      await page.getByRole("combobox", { name: "Reasoning" }).waitFor();
      assert.ok((await optionTexts(page, "Reasoning")).includes("default||Standard (Anbieter)"));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
      for (const box of await page.locator(".chat-model select").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) assert.ok(box <= 400, `select ends at ${box}`);
      await expectAxeClean(page, "chat model picker de 400");
    });
  });
});
