// Memory step of the wizard: the models the engine runs (model.memory.status), what the step writes into engine.embedding and
// engine.reranker, and the non-commercial licence gate (ADR-006): an NC model is selectable only through the confirmation dialog.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { FRESH_MEMORY, GEMMA_BLOCK, ISO, changes, next, open, seed, stepHeading } from "./setup-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

/** Account -> Memory; `status` replaces the engine's answer of a fresh install. */
async function toMemory(app: App, status: unknown = FRESH_MEMORY): Promise<void> {
  seed(app.server.rpc); app.server.rpc.handle("model.memory.status", () => structuredClone(status), { write: false });
  await open(app);
  await stepHeading(app.page, "Your account").waitFor(); await next(app.page);
  await stepHeading(app.page, /Memory/).waitFor();
  await app.page.getByRole("radio", { name: /BGE-reranker-v2-m3/ }).waitFor();
}
const persona = (p: Page) => stepHeading(p, "Name & persona").waitFor();
const reranker = (model: string) => ({ key: "engine.reranker", value: { provider: "local-transformers", local: { model } } });
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
      await persona(page);
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
      assert.match(text, /jinaai\/jina-embeddings-v5-text-nano/); assert.match(text, /ac5d898c8d382b17167c33e5c8af644a3519b47d/);
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
      assert.match((await dialog(page).textContent()) ?? "", /Revision\s*68ed94909d564380f954be27ae2e133214c1adc9/);
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
      await persona(page);
      assert.deepEqual(changes(app).at(-1)!, [{ key: "embedding.useClass", value: "general" }, GEMMA_BLOCK]);
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
      await persona(page);
      const last = changes(app).at(-1)!;
      assert.deepEqual(last.map((c) => c.key), ["embedding.useClass", "embedding.acceptedNcLicence", "embedding.acceptedNcLicenceAt", "engine.embedding"]);
      assert.equal(last[0]?.value, "research"); assert.equal(last[1]?.value, true);
      assert.match(String(last[2]?.value), ISO);
      assert.deepEqual(last[3]?.value, { provider: "local-transformers", local: { model: "jinaai/jina-embeddings-v5-text-nano-retrieval", dimensions: 768 } });
      assert.deepEqual(app.server.rpc.calls.filter((c) => c.method === "model.licence.confirm").map((c) => c.params), [{ model: "jinaai/jina-embeddings-v5-text-nano-retrieval", accepted: true }]);
    });
  });

  test("an NC reranker needs its own confirmation and is written to engine.reranker", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      await page.getByRole("radio", { name: /Jina reranker v2/ }).click();
      await dialog(page).getByRole("button", { name: "I confirm non-commercial use" }).click();
      await next(page);
      await persona(page);
      const last = changes(app).at(-1)!;
      assert.deepEqual(last.map((c) => c.key), ["embedding.useClass", "embedding.acceptedNcLicence", "embedding.acceptedNcLicenceAt", "engine.embedding", "engine.reranker"]);
      assert.deepEqual(last[4], reranker("jinaai/jina-reranker-v2-base-multilingual"));
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
      await persona(page);
      assert.deepEqual(changes(app).at(-1)!.map((c) => c.key), ["embedding.useClass", "engine.embedding"]);
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
      await persona(page);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).check();
      await next(page);
      await persona(page);
      assert.deepEqual(changes(app).at(-1)!, [
        { key: "embedding.useClass", value: "general" }, { key: "embedding.acceptedNcLicence", value: false }, GEMMA_BLOCK,
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
      await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).waitFor();
      assert.equal(await jina5(page).isChecked(), false);
      assert.equal(await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).isChecked(), true);
    });
  });
});

describe("setup wizard: what the memory engine runs", opts, () => {
  test("only models the engine can load are offered", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      const labels = await page.locator(".setup-opts label").allTextContents();
      assert.ok(!labels.some((l) => /Qwen3/.test(l)), labels.join(" | "));
      assert.equal(await page.locator('input[name="setup-embedding"]').count(), 4);
      assert.equal(await page.locator('input[name="setup-rerank"]').count(), 2);
    });
  });

  test("a store with data keeps its embedding model: the others are disabled with the reembed hint; the reranker still changes", async () => {
    await withApp({}, async (app) => {
      await toMemory(app, { ...FRESH_MEMORY, embeddingSwitch: "migration-required" }); const { page } = app;
      assert.equal(await page.getByRole("radio", { name: /multilingual-e5-small/ }).isChecked(), true);
      assert.equal(await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).isDisabled(), true);
      assert.equal(await jina5(page).isDisabled(), true);
      await page.getByText(/already holds data embedded with intfloat\/multilingual-e5-small.*plur1bus memory reembed/).waitFor();
      await expectAxeClean(page, "memory step, store with data");
      await page.getByRole("radio", { name: /Jina reranker v2/ }).click();
      await dialog(page).getByRole("button", { name: "I confirm non-commercial use" }).click();
      await next(page);
      await persona(page);
      const last = changes(app).at(-1)!;
      assert.ok(!last.some((c) => c.key === "engine.embedding"), "the embedding model of a store with data is never written");
      assert.deepEqual(last.at(-1), reranker("jinaai/jina-reranker-v2-base-multilingual"));
    });
  });

  // The store holds data embedded with Jina v3 (non-commercial): the engine needs the licence acceptance to load it.
  const JINA_STORE = { ...FRESH_MEMORY, embedding: { provider: "local-transformers", model: "jinaai/jina-embeddings-v3", dimensions: 1024, configured: true }, embeddingSwitch: "migration-required" };

  test("a store embedded with a non-commercial model keeps its licence: commercial use is disabled with the reason", async () => {
    await withApp({}, async (app) => {
      await toMemory(app, JINA_STORE); const { page } = app;
      assert.equal(await page.getByRole("radio", { name: /Jina embeddings v3/ }).isChecked(), true);
      const commercial = page.getByRole("radio", { name: "Commercial", exact: true });
      assert.equal(await commercial.isDisabled(), true);
      assert.match((await page.locator("#setup-use-commercial-d").textContent()) ?? "", /embedded with jinaai\/jina-embeddings-v3, which has a non-commercial licence.*plur1bus memory reembed/);
      await expectAxeClean(page, "memory step, non-commercial embedding in use");
      await page.getByRole("radio", { name: "Research, non-commercial", exact: true }).check();
      await next(page);
      await persona(page);
      // No model and no licence flag: the store stays on Jina v3 with its acceptance.
      assert.deepEqual(changes(app).at(-1)!.filter((c) => c.key.startsWith("embedding.") || c.key.startsWith("engine.")), [{ key: "embedding.useClass", value: "research" }]);
    });
  });

  test("a saved commercial use class next to such a store is refused before anything is written", async () => {
    await withApp({}, async (app) => {
      await toMemory(app, JINA_STORE); const { page } = app;
      await page.evaluate(() => {
        const o = JSON.parse(localStorage.getItem("plur1bus.web.setup")!);
        o.answers.useClass = "commercial"; localStorage.setItem("plur1bus.web.setup", JSON.stringify(o));
      });
      await page.reload();
      await stepHeading(page, /Memory/).waitFor();
      await page.getByRole("radio", { name: /Jina embeddings v3/ }).waitFor();
      const before = changes(app).length;
      await next(page);
      await page.getByRole("alert").getByText(/Commercial use is not possible while the memory is embedded with jinaai\/jina-embeddings-v3/).waitFor();
      // The page moves focus to the first field it marks invalid on the next frame.
      await page.waitForFunction(() => document.activeElement?.id === "setup-use-general");
      assert.equal(changes(app).length, before, "nothing is written");
      await stepHeading(page, /Memory/).waitFor();
    });
  });

  test("a model the step does not offer is shown as in use and kept", async () => {
    await withApp({}, async (app) => {
      await toMemory(app, { ...FRESH_MEMORY, embedding: { provider: "openai", model: "text-embedding-3-large", dimensions: 3072, configured: true } }); const { page } = app;
      const current = page.getByRole("radio", { name: "In use: text-embedding-3-large · 3072 (openai)" });
      assert.equal(await current.isChecked(), true);
      await expectAxeClean(page, "memory step, model in use not offered");
      // With a cloud text embedding the media part preselects no captioning (media-search contract): choose it.
      await page.locator("#setup-caption-local").check();
      await next(page);
      await persona(page);
      assert.deepEqual(changes(app).at(-1)!.filter((c) => c.key.startsWith("engine.") || c.key === "embedding.useClass"), [{ key: "embedding.useClass", value: "general" }]);
    });
  });

  test("an explicitly chosen active model is preselected and an untouched step writes no model", async () => {
    await withApp({}, async (app) => {
      await toMemory(app, { ...FRESH_MEMORY, embedding: { ...FRESH_MEMORY.embedding, configured: true } }); const { page } = app;
      assert.equal(await page.getByRole("radio", { name: /multilingual-e5-small/ }).isChecked(), true);
      await next(page);
      await persona(page);
      assert.deepEqual(changes(app).at(-1)!, [{ key: "embedding.useClass", value: "general" }]);
    });
  });

  test("a refusal of the pre-check keeps the step, names the model in use and marks nothing done", async () => {
    await withApp({}, async (app) => {
      await toMemory(app); const { page } = app;
      app.server.rpc.handle("config.set", () => { throw rpcError("E_CONFLICT", "store holds data", "embedding-migration-required"); });
      await next(page);
      await page.getByRole("alert").getByText(/already holds data embedded with intfloat\/multilingual-e5-small/).waitFor();
      await stepHeading(page, /Memory/).waitFor();
    });
  });

  test("when the engine's models cannot be loaded the step says so and writes no model", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.scenario("model.memory.status", "error");
      await open(app);
      const { page } = app;
      await stepHeading(page, "Your account").waitFor(); await next(page);
      await page.getByText(/could not be loaded/).waitFor();
      assert.equal(await page.locator('input[name="setup-embedding"]').count(), 0);
      await next(page);
      await persona(page);
      assert.deepEqual(changes(app).at(-1)!, [{ key: "embedding.useClass", value: "general" }]);
    });
  });
});
