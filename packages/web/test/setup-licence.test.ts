// Memory step of the wizard: the non-commercial licence gate (ADR-006). An NC model is selectable only through the confirmation dialog.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { browserSkip, setup, teardown, withApp, type App } from "./harness.ts";
import { ISO, changes, next, open, seed, skip, stepHeading, toSwitchboard } from "./setup-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function toMemory(app: App): Promise<void> {
  seed(app.server.rpc); await open(app);
  await toSwitchboard(app); await skip(app.page);
  await stepHeading(app.page, /Memory/).waitFor();
}
const jina5 = (p: Page) => p.getByRole("radio", { name: /Jina v5 Text Nano/ });
const dialog = (p: Page) => p.getByRole("dialog", { name: "Accept a non-commercial licence?" });

describe("setup wizard: NC licence gate", opts, () => {
  test("permissive defaults are preselected (EmbeddingGemma 2 and BGE); NC models are labelled and unchecked", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      assert.equal(await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).isChecked(), true);
      assert.equal(await page.getByRole("radio", { name: /BGE-reranker-v2-m3/ }).isChecked(), true);
      assert.equal(await jina5(page).isChecked(), false);
      assert.match((await page.getByText("Jina v5 Text Nano").locator("..").textContent()) ?? "", /non-commercial licence/);
      assert.equal(await page.getByRole("radio", { name: "General, personal use" }).isChecked(), true);
    });
  });

  test("the default (EmbeddingGemma 2, Apache-2.0) needs no licence dialog, for every use class", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      for (const use of ["General, personal use", "Research, non-commercial", "Commercial"]) {
        await page.getByRole("radio", { name: use, exact: true }).check();
        assert.equal(await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).isChecked(), true, use);
        assert.equal(await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).isDisabled(), false, use);
        assert.equal(await dialog(page).count(), 0, use);
      }
      await next(page);
      await stepHeading(page, /Language for voice features/).waitFor();
      const keys = changes(app).at(-1)!.map((c) => c.key);
      assert.ok(!keys.includes("embedding.acceptedNcLicence"), "no licence flag is written for the default");
    });
  });

  test("selecting an NC model only opens the dialog; it shows who, when, licence, model and revision", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await jina5(page).click();
      const d = dialog(page); await d.waitFor();
      assert.equal(await jina5(page).isChecked(), false, "not selected before the confirmation");
      const text = (await d.textContent()) ?? "";
      assert.match(text, /Confirmed by\s*owner/); assert.match(text, /Date and time\s*\S/); assert.match(text, /Licence\s*CC BY-NC-4\.0/);
      assert.match(text, /jinaai\/jina-embeddings-v5-text-nano/); assert.match(text, /not pinned in the ADR-006 table/);
      await page.keyboard.press("Escape");
      await d.waitFor({ state: "detached" });
      assert.equal(await jina5(page).isChecked(), false);
      assert.equal(await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).isChecked(), true);
    });
  });

  test("a pinned revision is shown (Jina v3)", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await page.getByRole("radio", { name: /Jina embeddings v3/ }).click();
      assert.match((await dialog(page).textContent()) ?? "", /Revision\s*68ed9490…adc9/);
    });
  });

  test("cancel keeps the permissive default and writes no licence flag", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await jina5(page).click();
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await dialog(page).waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "setup-embedding-jina-v5-nano", "focus returns to the radio");
      await next(page);
      await stepHeading(page, /Language for voice features/).waitFor();
      const last = changes(app).at(-1)!;
      assert.deepEqual(last.map((c) => c.key), ["embedding.useClass", "modelRoles.rerank"]);
    });
  });

  test("confirm selects the model and Next writes the flag and the confirmation time", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await page.getByRole("radio", { name: "Research, non-commercial" }).check();
      await jina5(page).click();
      await dialog(page).getByRole("button", { name: "I confirm non-commercial use" }).click();
      await dialog(page).waitFor({ state: "detached" });
      assert.equal(await jina5(page).isChecked(), true);
      await page.getByText(/Confirmed by owner on/).waitFor();
      await next(page);
      await stepHeading(page, /Language for voice features/).waitFor();
      const last = changes(app).at(-1)!;
      assert.deepEqual(last.map((c) => c.key), ["embedding.useClass", "embedding.acceptedNcLicence", "embedding.acceptedNcLicenceAt", "modelRoles.rerank"]);
      assert.equal(last[0]?.value, "research"); assert.equal(last[1]?.value, true);
      assert.match(String(last[2]?.value), ISO);
      assert.equal(last[3]?.value, "BAAI/bge-reranker-v2-m3");
    });
  });

  test("an NC reranker needs its own confirmation and sets modelRoles.rerank", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await page.getByRole("radio", { name: /Jina reranker v2/ }).click();
      await dialog(page).getByRole("button", { name: "I confirm non-commercial use" }).click();
      await next(page);
      await stepHeading(page, /Language for voice features/).waitFor();
      const last = changes(app).at(-1)!;
      assert.deepEqual(last.map((c) => c.key), ["embedding.useClass", "embedding.acceptedNcLicence", "embedding.acceptedNcLicenceAt", "modelRoles.rerank"]);
      assert.equal(last[3]?.value, "jinaai/jina-reranker-v2-base-multilingual");
    });
  });

  test("commercial use: NC models are disabled with a reason, and an earlier confirmation is forgotten", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await jina5(page).click();
      await dialog(page).getByRole("button", { name: "I confirm non-commercial use" }).click();
      assert.equal(await jina5(page).isChecked(), true);
      await page.getByRole("radio", { name: "Commercial", exact: true }).check();
      assert.equal(await jina5(page).isDisabled(), true);
      assert.equal(await jina5(page).isChecked(), false);
      assert.equal(await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).isChecked(), true);
      assert.match((await page.locator("#setup-embedding-jina-v5-nano-d").textContent()) ?? "", /Not available for commercial use/);
      await next(page);
      await stepHeading(page, /Language for voice features/).waitFor();
      assert.deepEqual(changes(app).at(-1)!.map((c) => c.key), ["embedding.useClass", "modelRoles.rerank"]);
    });
  });

  test("only the owner can accept: a member sees the NC models disabled", async () => {
    await withApp({ server: { role: "member" } }, async (app) => {
      await toMemory(app); const { page } = app;
      assert.equal(await jina5(page).isDisabled(), true);
      assert.match((await page.locator("#setup-embedding-jina-v5-nano-d").textContent()) ?? "", /Only the owner/);
    });
  });

  test("declining after an earlier acceptance writes the flag back to false", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await jina5(page).click();
      await dialog(page).getByRole("button", { name: "I confirm non-commercial use" }).click();
      await next(page);
      await stepHeading(page, /Language for voice features/).waitFor();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).check();
      await next(page);
      await stepHeading(page, /Language for voice features/).waitFor();
      assert.deepEqual(changes(app).at(-1)!, [
        { key: "embedding.useClass", value: "general" }, { key: "embedding.acceptedNcLicence", value: false }, { key: "modelRoles.rerank", value: "BAAI/bge-reranker-v2-m3" },
      ]);
    });
  });

  test("a saved NC choice without a recorded confirmation is dropped on reload", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await page.evaluate(() => {
        const o = JSON.parse(localStorage.getItem("plur1bus.web.setup")!);
        o.answers.embedding = "jina-v5-nano"; o.answers.nc = null; localStorage.setItem("plur1bus.web.setup", JSON.stringify(o));
      });
      await page.reload();
      await stepHeading(page, /Memory/).waitFor();
      assert.equal(await jina5(page).isChecked(), false);
      assert.equal(await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).isChecked(), true);
    });
  });
});
