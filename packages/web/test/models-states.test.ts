// Models page: filters, list and detail states, optional fields (no invented labels), keyboard use of the list and axe.
// Complements models.test.ts (happy paths, scan, overrides, layout), models-logic.test.ts (pure logic), models-roles.test.ts
// (who sees which control) and models-names.test.ts (no vendor name in the UI code). Everything runs against test/mock-rpc.ts;
// holding an answer back uses a hand-opened gate (models-fixtures.ts), never a timer.
//
// The page has two selects (provider, status) and a "new only" toggle as its filters. It has no free-text search box; there is
// nothing to type into, so "narrow by text" is covered by the select filters and the no-match state below.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { gate, installCatalog, keyOf, listResult, model, requiredOnly, rpcError, type Model } from "./models-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const open = async (app: App, hash = "#/models", lang: "en" | "de" = "en"): Promise<void> => { await openRoute(app.page, hash, lang); };
const link = (page: Page, name: string | RegExp) => page.getByRole("link", { name });
const detailOf = (page: Page) => page.getByRole("region", { name: "Model details" });
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);

/** The visible model names of the list, in order (the first span of every row; badges follow it). */
const rowNames = (page: Page): Promise<string[]> => page.locator(".model-list a.nav-link > span:first-child").allTextContents();
const groupNames = (page: Page): Promise<string[]> => page.locator(".model-list h2.group-label").allTextContents();
const optionValues = (page: Page, select: string): Promise<string[]> => page.locator(`${select} option`).evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
/** The detail card's `dt` -> `dd` pairs by their visible label. */
const facts = (page: Page): Promise<Record<string, string>> => page.evaluate(() => Object.fromEntries(
  Array.from(document.querySelectorAll(".ld-detail dl.facts > div")).map((r) => [r.querySelector("dt")!.textContent!.trim(), r.querySelector("dd")!.textContent!.trim()])));
const hrefOf = (provider: string, id: string): string => `#/models/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;
const select = async (page: Page, id: string, value: string): Promise<void> => { await page.locator(id).selectOption(value); };

const ALL = ["Alpha One", "Alpha Two", "Alpha Three", "Beta One", "Beta Manual", "Gamma One"];
const CAP_LABELS = ["Tools", "Vision", "Reasoning", "Audio in", "Audio out", "Structured output", "Prompt caching"];

/** Opens one model by route and waits for its card. */
async function showModel(page: Page, provider: string, id: string, heading: string): Promise<void> {
  await page.evaluate((h) => { location.hash = h; }, hrefOf(provider, id));
  await detailOf(page).getByRole("heading", { name: heading, level: 2, exact: true }).waitFor();
}

describe("models: filters", opts, () => {
  test("provider and status narrow the list, the provider choices come from the data, and clearing restores everything", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      assert.deepEqual(await rowNames(app.page), ALL);
      assert.deepEqual(await groupNames(app.page), ["alpha", "beta", "gamma"]);
      // the choices are "All" plus the providers of the answer (scan states first, then providers only seen on a model): nothing else
      assert.deepEqual(await optionValues(app.page, "#mf-provider"), ["", "alpha", "beta", "gamma"]);
      assert.deepEqual(await optionValues(app.page, "#mf-status"), ["", "available", "unavailable", "manual"]);

      await select(app.page, "#mf-provider", "beta");
      assert.deepEqual(await rowNames(app.page), ["Beta One", "Beta Manual"]);
      assert.deepEqual(await groupNames(app.page), ["beta"]);
      await select(app.page, "#mf-status", "unavailable");
      assert.equal(await app.page.getByText("No model matches the filters.").count(), 1, "beta has no unavailable model");
      assert.deepEqual(await rowNames(app.page), []);
      assert.deepEqual(await groupNames(app.page), [], "no empty provider headings are left behind");

      await select(app.page, "#mf-provider", "");
      assert.deepEqual(await rowNames(app.page), ["Alpha Three", "Gamma One"]);
      await select(app.page, "#mf-provider", "alpha");
      assert.deepEqual(await rowNames(app.page), ["Alpha Three"]);

      await select(app.page, "#mf-status", "");
      assert.deepEqual(await rowNames(app.page), ["Alpha One", "Alpha Two", "Alpha Three"]);
      await select(app.page, "#mf-provider", "");
      assert.deepEqual(await rowNames(app.page), ALL, "clearing both filters restores the full list");
      assert.equal(await app.page.getByText("No model matches the filters.").count(), 0);
    });
  });

  test("'Only new models' is a pressed toggle that combines with the selects; the empty result offers its own way out", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      const toggle = app.page.getByRole("button", { name: "Only new models" });
      assert.equal(await toggle.getAttribute("aria-pressed"), "false");
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-pressed"), "true");
      assert.deepEqual(await rowNames(app.page), ["Alpha One", "Beta One"]);
      await select(app.page, "#mf-provider", "beta");
      assert.deepEqual(await rowNames(app.page), ["Beta One"]);
      await select(app.page, "#mf-status", "manual");
      await app.page.getByText("No model matches the filters.").waitFor();
      // the controls that produced the empty result are still on screen, so the way back is visible
      assert.equal(await app.page.locator("#mf-provider").inputValue(), "beta");
      assert.equal(await app.page.locator("#mf-status").inputValue(), "manual");
      assert.equal(await toggle.getAttribute("aria-pressed"), "true");
      await select(app.page, "#mf-status", ""); await select(app.page, "#mf-provider", ""); await toggle.click();
      assert.equal(await toggle.getAttribute("aria-pressed"), "false");
      assert.deepEqual(await rowNames(app.page), ALL);
    });
  });

  test("a filter survives Refresh, and a provider that vanishes from the catalog does not leave an invisible filter behind", async () => {
    await withApp({}, async (app) => {
      const c = installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      await select(app.page, "#mf-provider", "beta");
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await link(app.page, /Beta One/).waitFor();
      assert.deepEqual(await rowNames(app.page), ["Beta One", "Beta Manual"], "the filter is kept while the list reloads");
      assert.equal(await app.page.locator("#mf-provider").inputValue(), "beta");

      // gamma is only known through its model, so its choice disappears with the model
      await select(app.page, "#mf-provider", "gamma");
      c.models = c.models.filter((m) => m.provider !== "gamma");
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.locator('#mf-provider option[value="gamma"]').waitFor({ state: "detached" });
      assert.deepEqual(await optionValues(app.page, "#mf-provider"), ["", "alpha", "beta"]);
      // what the select shows is what filters the list: "All" over an empty "No model matches" list is a filter nobody can see
      const shown = await app.page.locator("#mf-provider").inputValue();
      assert.equal(shown, "", "the filter on a provider that is gone is dropped");
      assert.deepEqual(await rowNames(app.page), ["Alpha One", "Alpha Two", "Alpha Three", "Beta One", "Beta Manual"]);
      assert.equal(await app.page.getByText("No model matches the filters.").count(), 0);
    });
  });
});

describe("models: list states", opts, () => {
  test("loading: a busy status and nothing to act on until the catalog arrives", async () => {
    await withApp({}, async (app) => {
      const c = installCatalog(app.server.rpc); const g = gate();
      app.server.rpc.handle("models.list", async (p) => { await g.wait; return listResult(c, p); }, { write: false });
      await open(app);
      const state = app.page.locator('.page-state[data-state="loading"]');
      await state.waitFor();
      assert.equal(await state.getAttribute("role"), "status");
      assert.equal(await state.getAttribute("aria-busy"), "true");
      await app.page.getByRole("heading", { name: "Models", level: 1 }).waitFor();
      assert.equal(await app.page.locator(".model-list").count(), 0);
      for (const name of ["Scan providers", "Add manual model", "Refresh"]) assert.equal(await app.page.getByRole("button", { name }).count(), 0, `no ${name} while loading`);
      g.open();
      await link(app.page, /Gamma One/).waitFor();
      assert.equal(await app.page.locator(".page-state").count(), 0);
    });
  });

  test("Refresh keeps the list on screen while the new answer is on its way", async () => {
    await withApp({}, async (app) => {
      const c = installCatalog(app.server.rpc); const g = gate(); let hold = false;
      app.server.rpc.handle("models.list", async (p) => { if (hold) await g.wait; return listResult(c, p); }, { write: false });
      await open(app);
      await link(app.page, /Gamma One/).waitFor();
      hold = true;
      await app.page.getByRole("button", { name: "Refresh" }).click();
      assert.equal(await app.page.locator(".page-state").count(), 0, "no loading state replaces the list");
      assert.deepEqual(await rowNames(app.page), ALL);
      c.models.push(model({ id: "alpha-9", displayName: "Alpha Nine" }));
      g.open();
      await link(app.page, /Alpha Nine/).waitFor();
    });
  });

  test("empty catalog: an explanation and a scan, no filters, no providers card, no 'new' controls", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: [], newIds: new Set() }); await open(app);
      await app.page.getByRole("heading", { name: "No models in the catalog yet" }).waitFor();
      await app.page.getByText("Scan your providers to discover their models, or add one by hand.").waitFor();
      await app.page.locator(".page-state").getByRole("button", { name: "Scan providers" }).waitFor();
      assert.equal(await app.page.locator(".model-list").count(), 0);
      assert.equal(await app.page.locator("#mf-provider").count(), 0);
      assert.equal(await app.page.getByRole("group", { name: "Providers" }).count(), 0);
      assert.equal(await app.page.getByRole("button", { name: /as seen/ }).count(), 0);
      assert.equal(calls(app, "models.list").length, 1, "nothing is new, so the newOnly list is not asked for");
    });
  });

  test("an answer the page cannot read does not break it", async () => {
    for (const bad of [null, { models: "none" }, { models: [{ id: "no-provider" }, 7, null] }]) {
      await withApp({}, async (app) => {
        installCatalog(app.server.rpc);
        app.server.rpc.handle("models.list", () => bad, { write: false });
        await open(app);
        await app.page.locator(".page-state:not([data-state=loading])").waitFor();
        assert.match((await app.page.locator(".page-state").getAttribute("data-state")) ?? "", /^(empty|error)$/);
        await app.page.getByRole("heading", { name: "Models", level: 1 }).waitFor();
        assert.equal(await app.page.locator(".model-list").count(), 0);
        assert.deepEqual(app.problems, []);
      });
    }
  });

  test("error, forbidden and unavailable offer no catalog actions; only the error offers 'Try again', and it recovers", async () => {
    for (const state of ["error", "forbidden", "unavailable"] as const) {
      await withApp({}, async (app) => {
        installCatalog(app.server.rpc); app.server.rpc.scenario("models.list", state);
        await open(app);
        const box = app.page.locator(`.page-state[data-state=${state}]`);
        await box.waitFor();
        if (state === "error") assert.equal(await box.getAttribute("role"), "alert");
        for (const name of ["Scan providers", "Add manual model", "Refresh"]) assert.equal(await app.page.getByRole("button", { name }).count(), 0, `${state}: no ${name}`);
        assert.equal(await app.page.locator(".model-list").count(), 0);
        assert.equal(await app.page.getByRole("button", { name: "Try again" }).count(), state === "error" ? 1 : 0);
        if (state === "error") {
          app.server.rpc.scenario("models.list", "success");
          await app.page.getByRole("button", { name: "Try again" }).click();
          await link(app.page, /Gamma One/).waitFor();
          assert.equal(await app.page.locator(".page-state").count(), 0);
        }
      });
    }
  });

  test("a failing 'new only' question keeps the list; only the 'new' badges are missing", async () => {
    await withApp({}, async (app) => {
      const c = installCatalog(app.server.rpc);
      app.server.rpc.handle("models.list", (p) => {
        if ((p as { newOnly?: boolean } | undefined)?.newOnly === true) throw rpcError("E_INTERNAL", "boom");
        return listResult(c, p);
      }, { write: false });
      await open(app);
      await link(app.page, /Gamma One/).waitFor();
      assert.deepEqual(await rowNames(app.page), ALL);
      assert.equal(await app.page.locator(".model-list .badge", { hasText: /^new$/ }).count(), 0);
      assert.deepEqual(app.problems, []);
    });
  });
});

describe("models: detail states", opts, () => {
  test("no selection shows the hint, an unknown model says so, a malformed route is treated as no selection", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      await detailOf(app.page).getByText("Select an item to see its details.").waitFor();
      assert.equal(await detailOf(app.page).getByRole("heading").count(), 0);
      assert.equal(await app.page.getByRole("button", { name: "Edit overrides" }).count(), 0);

      await app.page.evaluate((h) => { location.hash = h; }, hrefOf("alpha", "no-such-model"));
      await detailOf(app.page).getByText("This model is not in the catalog.").waitFor();
      assert.equal(await detailOf(app.page).getByRole("heading").count(), 0);
      assert.equal(await app.page.getByRole("button", { name: "Edit overrides" }).count(), 0);
      assert.deepEqual(await rowNames(app.page), ALL, "the list is untouched");
      assert.equal(await app.page.locator(".model-list [aria-current]").count(), 0);

      for (const bad of ["#/models/only-one-part", "#/models/%E0%A4%A/x", "#/models/a/b/c"]) {
        await app.page.evaluate((h) => { location.hash = h; }, bad);
        await detailOf(app.page).getByText("Select an item to see its details.").waitFor();
      }
    });
  });

  test("a direct link opens the model, marks its row as current and decodes provider and id", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: [
        model({ provider: "my provider", id: "org/model:8b x", displayName: "Odd Id" }), model({ id: "alpha-2", displayName: "Alpha Two" })], newIds: new Set() });
      await open(app, hrefOf("my provider", "org/model:8b x"));
      await detailOf(app.page).getByRole("heading", { name: "Odd Id", level: 2 }).waitFor();
      const f = await facts(app.page);
      assert.equal(f["Provider"], "my provider");
      assert.equal(f["Model id"], "org/model:8b x");
      const current = app.page.locator(".model-list a[aria-current]");
      assert.equal(await current.count(), 1);
      assert.match((await current.textContent()) ?? "", /Odd Id/);
      assert.equal(await app.page.locator(".model-list a.nav-link").first().getAttribute("href"), hrefOf("my provider", "org/model:8b x"));
    });
  });

  test("detail while loading is the page's loading state, detail after a failure is its error state with a way back", async () => {
    await withApp({}, async (app) => {
      const c = installCatalog(app.server.rpc); const g = gate();
      app.server.rpc.handle("models.list", async (p) => { await g.wait; return listResult(c, p); }, { write: false });
      await open(app, hrefOf("alpha", "alpha-2"));
      await app.page.locator('.page-state[data-state="loading"]').waitFor();
      assert.equal(await detailOf(app.page).count(), 0, "no half-drawn detail while loading");
      g.open();
      await detailOf(app.page).getByRole("heading", { name: "Alpha Two", level: 2 }).waitFor();
    });
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc); app.server.rpc.scenario("models.list", "error");
      await open(app, hrefOf("alpha", "alpha-2"));
      await app.page.locator('.page-state[data-state="error"]').waitFor();
      assert.equal(await detailOf(app.page).count(), 0);
      assert.equal(await app.page.getByRole("button", { name: "Edit overrides" }).count(), 0);
      app.server.rpc.scenario("models.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await detailOf(app.page).getByRole("heading", { name: "Alpha Two", level: 2 }).waitFor();
    });
  });

  test("a model that disappears while its detail is open turns into the 'not in the catalog' note", async () => {
    await withApp({}, async (app) => {
      const c = installCatalog(app.server.rpc); app.server.events.enable();
      await open(app, hrefOf("alpha", "alpha-2"));
      await detailOf(app.page).getByRole("heading", { name: "Alpha Two", level: 2 }).waitFor();
      await app.server.events.waitForConnections(1);
      c.models = c.models.filter((m) => m.id !== "alpha-2");
      app.server.events.push({ event: "models.changed", data: { provider: "alpha", discovered: [], reappeared: [], unavailable: ["alpha-2"], at: "2026-10-07T09:00:00Z" } });
      await detailOf(app.page).getByText("This model is not in the catalog.").waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Edit overrides" }).count(), 0);
    });
  });

  test("a failed save or remove is explained inside its dialog, keeps the dialog open and can be retried", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc); await open(app, hrefOf("beta", "beta-2"));
      await detailOf(app.page).getByRole("heading", { name: "Beta Manual", level: 2 }).waitFor();
      app.server.rpc.handle("models.setOverride", () => { throw rpcError("E_INTERNAL", "boom"); });
      await app.page.getByRole("button", { name: "Edit overrides" }).click();
      const edit = app.page.getByRole("dialog", { name: "Edit overrides: Beta Manual" });
      await edit.getByLabel("Display name").fill("Renamed");
      await edit.getByRole("button", { name: "Save" }).click();
      await edit.getByRole("alert").getByText("The change could not be saved. Try again.").waitFor();
      assert.equal(await edit.count(), 1, "the dialog stays open");
      assert.equal(calls(app, "models.setOverride").length, 1);
      app.server.rpc.handle("models.setOverride", () => model({ provider: "beta", id: "beta-2", displayName: "Renamed" }));
      await edit.getByRole("button", { name: "Save" }).click();
      await edit.waitFor({ state: "detached" });

      app.server.rpc.handle("models.removeManual", () => { throw rpcError("E_INTERNAL", "boom"); });
      await app.page.getByRole("button", { name: "Remove manual model" }).click();
      const confirm = app.page.getByRole("dialog", { name: "Remove manual model" });
      await confirm.getByRole("button", { name: "Remove", exact: true }).click();
      await confirm.getByRole("alert").getByText("The change could not be saved. Try again.").waitFor();
      assert.equal(await confirm.count(), 1);
      assert.equal(await detailOf(app.page).getByRole("heading", { level: 2 }).count(), 1, "the model is still there");
    });
  });

  test("after removing the only model of a provider the filter on that provider does not hide the rest of the catalog", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: [model(), model({ provider: "local", id: "tiny", displayName: "Tiny", source: "manual", status: "manual" })], newIds: new Set() });
      await open(app);
      await link(app.page, /Tiny/).waitFor();
      await select(app.page, "#mf-provider", "local");
      assert.deepEqual(await rowNames(app.page), ["Tiny"]);
      await link(app.page, /Tiny/).click();
      await app.page.getByRole("button", { name: "Remove manual model" }).click();
      await app.page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      await link(app.page, /Tiny/).waitFor({ state: "detached" });
      await app.page.locator('#mf-provider option[value="local"]').waitFor({ state: "detached" });
      assert.equal(await app.page.locator("#mf-provider").inputValue(), "");
      assert.deepEqual(await rowNames(app.page), ["Alpha One"], "the select says All, so the list shows everything that is left");
    });
  });
});

describe("models: optional fields are shown only when the backend sends them", opts, () => {
  const FIELDS_ROW = ["Provider", "Model id", "Kind", "Context window", "Capabilities", "Aliases", "Status", "Source", "First seen", "Last seen", "Overrides"];

  test("an entry with every optional field shows each of them", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: [model({
        id: "full", displayName: "Full", kind: "embedding", contextWindow: 123456, capabilities: ["tools", "audio_in"], aliases: ["f-one", "f-two"],
        overrides: { displayName: "Full", kind: "embedding", contextWindow: 123456, capabilities: ["tools"], aliases: ["f-one"] }, note: "visible-note", rank: 3, flag: true })], newIds: new Set() });
      await open(app, hrefOf("alpha", "full"));
      await detailOf(app.page).getByRole("heading", { name: "Full", level: 2 }).waitFor();
      const f = await facts(app.page);
      assert.deepEqual(Object.keys(f), [...FIELDS_ROW, "Further fields"]);
      assert.equal(f["Kind"], "Embedding");
      assert.equal(f["Context window"], "123,456");
      assert.equal(f["Capabilities"], "Tools, Audio in");
      assert.equal(f["Aliases"], "f-one, f-two");
      assert.equal(await app.page.locator(".ld-detail dl.facts > div", { hasText: "Overrides" }).locator("li").count(), 5);
      assert.match(f["Further fields"]!, /note: visible-note/);
      assert.match(f["Further fields"]!, /rank: 3/);
      assert.match(f["Further fields"]!, /flag: true/);
    });
  });

  test("an entry with only the required keys shows 'unknown' / 'none' and no capability, no extra field, no badge", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: [requiredOnly()], providers: [], newIds: new Set() });
      await open(app, hrefOf("alpha", "plain"));
      await detailOf(app.page).getByRole("heading", { name: "Plain", level: 2 }).waitFor();
      const f = await facts(app.page);
      assert.deepEqual(Object.keys(f), FIELDS_ROW, "no 'Further fields' row without further fields");
      assert.equal(f["Kind"], "unknown");
      assert.equal(f["Context window"], "unknown");
      assert.equal(f["Capabilities"], "none");
      assert.equal(f["Aliases"], "none");
      assert.equal(f["Overrides"], "none");
      const main = (await app.page.locator("main").textContent()) ?? "";
      for (const label of CAP_LABELS) assert.ok(!main.includes(label), `${label} is shown although the entry has no such capability`);
      assert.equal(await app.page.locator("main .badge").count(), 1, "only the status badge of the detail card; no list badge, no capability badge");
      assert.equal(await app.page.locator(".model-list .badge").count(), 0);
    });
  });

  test("an entry with almost nothing is tolerated: id as the name, nothing invented, no 'Invalid Date' or 'NaN'", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: [{ provider: "alpha", id: "bare" }], providers: [], newIds: new Set() });
      await open(app, hrefOf("alpha", "bare"));
      await detailOf(app.page).getByRole("heading", { name: "bare", level: 2, exact: true }).waitFor();
      const f = await facts(app.page);
      assert.equal(f["Kind"], "unknown");
      assert.equal(f["Context window"], "unknown");
      assert.equal(f["Capabilities"], "none");
      assert.equal(f["Aliases"], "none");
      assert.equal(f["Source"], "unknown");
      assert.equal(f["First seen"], "unknown");
      assert.equal(f["Last seen"], "unknown");
      assert.equal(f["Overrides"], "none");
      assert.equal(f["Further fields"], undefined);
      const text = (await app.page.locator("main").textContent()) ?? "";
      assert.doesNotMatch(text, /Invalid Date|NaN|undefined|null|1970/);
      for (const label of CAP_LABELS) assert.ok(!text.includes(label), label);
      assert.deepEqual(app.problems, []);
    });
  });

  test("capabilities are listed exactly as sent: no missing one is added, a value the page does not know is dropped", async () => {
    const cases: { caps: unknown; shown: string }[] = [
      { caps: ["tools"], shown: "Tools" },
      { caps: ["vision", "reasoning"], shown: "Vision, Reasoning" },
      { caps: ["tools", "teleport", 7], shown: "Tools" },
      { caps: ["audio_out", "structured_output", "prompt_caching", "audio_in"], shown: "Audio out, Structured output, Prompt caching, Audio in" },
      { caps: [], shown: "none" },
      { caps: "tools", shown: "none" },
    ];
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: cases.map((c, i) => model({ id: `m-${i}`, displayName: `Model ${i}`, capabilities: c.caps })), newIds: new Set() });
      await open(app);
      await link(app.page, /Model 0/).waitFor();
      for (const [i, c] of cases.entries()) {
        await showModel(app.page, "alpha", `m-${i}`, `Model ${i}`);
        assert.equal((await facts(app.page))["Capabilities"], c.shown, JSON.stringify(c.caps));
        const detail = (await detailOf(app.page).textContent()) ?? "";
        const sent = c.shown === "none" ? [] : c.shown.split(", ");
        for (const label of CAP_LABELS.filter((l) => !sent.includes(l))) assert.ok(!detail.includes(label), `${label} shown for ${JSON.stringify(c.caps)}`);
        assert.equal(await app.page.locator(".model-list .badge", { hasText: new RegExp(CAP_LABELS.join("|")) }).count(), 0, "a list row never carries a capability badge");
      }
    });
  });

  test("context window, kind, aliases, dates and overrides: a missing or unreadable value is 'unknown' / 'none', a good one is shown", async () => {
    const rows: { id: string; over: Model; expect: Record<string, string | RegExp> }[] = [
      { id: "ctx-ok", over: { contextWindow: 8192 }, expect: { "Context window": "8,192" } },
      ...[0, -3, "big", 1.5, null].map((v, i) => ({ id: `ctx-bad-${i}`, over: { contextWindow: v }, expect: { "Context window": "unknown" } })),
      { id: "kind-ok", over: { kind: "embedding" }, expect: { Kind: "Embedding" } },
      { id: "kind-bad", over: { kind: "weird" }, expect: { Kind: "unknown" } },
      { id: "alias-mixed", over: { aliases: ["a-1", 5, "a-2"] }, expect: { Aliases: "a-1, a-2" } },
      { id: "alias-none", over: { aliases: [] }, expect: { Aliases: "none" } },
      { id: "date-bad", over: { firstSeen: "not a date", lastSeen: "" }, expect: { "First seen": "unknown", "Last seen": "unknown" } },
      { id: "date-ok", over: { firstSeen: "2026-10-03T07:12:44.120Z" }, expect: { "First seen": /2026/ } },
      { id: "source-bad", over: { source: "carrier-pigeon" }, expect: { Source: "unknown" } },
      { id: "source-table", over: { source: "table" }, expect: { Source: "Built-in table" } },
      { id: "ov-none", over: { overrides: {} }, expect: { Overrides: "none" } },
      { id: "ov-junk", over: { overrides: { teleport: 1, contextWindow: -1, kind: "weird" } }, expect: { Overrides: "none" } },
    ];
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: rows.map((r) => model({ id: r.id, displayName: r.id, ...r.over })), newIds: new Set() });
      await open(app);
      await link(app.page, /ctx-ok/).waitFor();
      for (const r of rows) {
        await showModel(app.page, "alpha", r.id, r.id);
        const f = await facts(app.page);
        for (const [label, want] of Object.entries(r.expect)) {
          if (typeof want === "string") assert.equal(f[label], want, `${r.id}: ${label}`); else assert.match(f[label]!, want, `${r.id}: ${label}`);
        }
      }
    });
  });

  test("overrides list exactly the fields that are overridden", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { models: [
        model({ id: "ov-a", displayName: "Ov A", overrides: { aliases: ["x-1"] } }),
        model({ id: "ov-b", displayName: "Ov B", overrides: { capabilities: [], displayName: "Ov B", contextWindow: 4096 } })], newIds: new Set() });
      await open(app);
      await link(app.page, /Ov A/).waitFor();
      const items = (): Promise<string[]> => app.page.locator(".ld-detail dl.facts > div", { hasText: "Overrides" }).locator("li").allTextContents();
      await showModel(app.page, "alpha", "ov-a", "Ov A");
      assert.deepEqual(await items(), ["Aliases: x-1"]);
      await showModel(app.page, "alpha", "ov-b", "Ov B");
      assert.deepEqual(await items(), ["Display name: Ov B", "Context window: 4,096", "Capabilities: none"]);
    });
  });

  test("further fields: scalar values only, secret-named values masked, and the backend's own 'new' flag is not one of them", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, {
        sendNewFlag: true,
        models: [
          model({ id: "fresh", displayName: "Fresh" }),
          model({ id: "seen", displayName: "Seen" }),
          model({ id: "extra", displayName: "Extra", note: "visible-note", apiKey: "sk-live-SECRET-9", nested: { a: 1 }, list: [1, 2] })],
        newIds: new Set([keyOf(model({ id: "fresh" }))]),
      });
      await open(app);
      await link(app.page, /Fresh/).waitFor();
      for (const [id, name] of [["fresh", "Fresh"], ["seen", "Seen"]] as const) {
        await showModel(app.page, "alpha", id, name);
        const f = await facts(app.page);
        assert.equal(f["Further fields"], undefined, `${name}: the 'new' flag of the entry is not a further field`);
        assert.doesNotMatch((await detailOf(app.page).textContent()) ?? "", /\bnew:/);
      }
      await showModel(app.page, "alpha", "extra", "Extra");
      const f = await facts(app.page);
      assert.match(f["Further fields"]!, /note: visible-note/);
      assert.match(f["Further fields"]!, /apiKey: ••••/);
      assert.doesNotMatch(f["Further fields"]!, /\bnew:|nested|list/);
      assert.ok(!(await app.page.content()).includes("sk-live-SECRET-9"));
    });
  });

  test("the 'new' badge and the acknowledge button appear only for what the backend calls new", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { newIds: new Set() }); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      assert.equal(await app.page.locator(".badge", { hasText: /^new$/ }).count(), 0);
      assert.equal(await app.page.getByRole("button", { name: /as seen/ }).count(), 0);
    });
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      const badged = await app.page.locator(".model-list a.nav-link", { has: app.page.locator(".badge", { hasText: /^new$/ }) }).locator("> span:first-child").allTextContents();
      assert.deepEqual(badged, ["Alpha One", "Beta One"]);
      await app.page.getByRole("button", { name: "Mark 2 new as seen" }).waitFor();
      await showModel(app.page, "alpha", "alpha-1", "Alpha One");
      assert.equal(await detailOf(app.page).locator(".badge", { hasText: /^new$/ }).count(), 1);
      await showModel(app.page, "alpha", "alpha-2", "Alpha Two");
      assert.equal(await detailOf(app.page).locator(".badge", { hasText: /^new$/ }).count(), 0);
    });
  });

  test("a list row has a badge only for a status other than available", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { newIds: new Set() }); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      const badges = (name: string): Promise<string[]> => app.page.locator(".model-list a.nav-link", { hasText: name }).locator(".badge").allTextContents();
      assert.deepEqual(await badges("Alpha Two"), []);
      assert.deepEqual(await badges("Alpha Three"), ["Unavailable"]);
      assert.deepEqual(await badges("Beta Manual"), ["Manual"]);
    });
  });

  test("provider scan states: result, last scan and failure count appear only when sent", async () => {
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { providers: [{ provider: "alpha" }, { provider: "beta", lastScanAt: "2026-10-03T07:12:44.120Z", lastResult: "ok" }], warnings: [] });
      await open(app);
      const card = app.page.getByRole("group", { name: "Providers" });
      await card.waitFor();
      const rows = await card.locator("li").allTextContents();
      assert.equal(rows.length, 2);
      assert.match(rows[0]!, /^alpha\s*never scanned$/);
      assert.match(rows[1]!, /^beta\s*last scan .*2026/);
      assert.equal(await card.locator(".badge").count(), 0, "no result badge without a failed result");
      assert.doesNotMatch((await card.textContent()) ?? "", /failed in a row|Scan finished/);
      assert.equal(await app.page.getByRole("heading", { name: "Warnings" }).count(), 0);
    });
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, {
        providers: [{ provider: "alpha", lastScanAt: "2026-10-03T07:12:44.120Z", lastResult: "failed:network", consecutiveFailures: 3 }],
        warnings: [{ code: "empty_list", provider: "beta" }],
      });
      await open(app);
      const card = app.page.getByRole("group", { name: "Providers" });
      await card.waitFor();
      const text = (await card.textContent()) ?? "";
      assert.match(text, /The provider could not be reached\./);
      assert.match(text, /3 failed in a row/);
      assert.match(text, /beta returned an empty model list; nothing was changed\./);
      await card.getByRole("heading", { name: "Warnings" }).waitFor();
    });
    await withApp({}, async (app) => {
      installCatalog(app.server.rpc, { providers: [], warnings: [] }); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      assert.equal(await app.page.getByRole("group", { name: "Providers" }).count(), 0, "no providers and no warnings: no card");
    });
  });

  test("German: the placeholders are the German ones, no English fallback leaks", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      installCatalog(app.server.rpc, { models: [requiredOnly()], providers: [{ provider: "alpha" }], newIds: new Set() });
      await open(app, hrefOf("alpha", "plain"), "de");
      await app.page.getByRole("region", { name: "Modelldetails" }).getByRole("heading", { name: "Plain", level: 2 }).waitFor();
      const f = await facts(app.page);
      assert.equal(f["Art"], "unbekannt");
      const text = (await app.page.locator("main").textContent()) ?? "";
      assert.match(text, /keine/);
      assert.match(text, /noch nie gescannt/);
      assert.doesNotMatch(text, /\bunknown\b|\bnone\b|never scanned/);
    });
  });
});

describe("models: keyboard use of the list", opts, () => {
  /** What the focused element is, read in the page. */
  const focused = (page: Page) => page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { tag: el.tagName, id: el.id, href: el.getAttribute("href"), text: (el.textContent ?? "").trim(), inList: !!el.closest(".model-list"), outline: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });

  test("Tab walks the filters and then every row in list order, each stop shows a focus ring, Shift+Tab walks back", async () => {
    await withApp({ width: 1440, height: 900 }, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      await app.page.locator("#mf-provider").focus();
      const stops: Awaited<ReturnType<typeof focused>>[] = [await focused(app.page)];
      for (let i = 0; i < 12; i++) {
        await app.page.keyboard.press("Tab");
        const s = await focused(app.page);
        if (!s.inList) break;
        stops.push(s);
      }
      assert.deepEqual(stops.map((s) => s.id || s.text.replace(/\s*(new|Unavailable|Manual)\s*$/, "")).slice(0, 3), ["mf-provider", "mf-status", "Only new models"]);
      const rows = stops.filter((s) => s.tag === "A");
      const expected = ALL.map((n) => n);
      assert.deepEqual(rows.map((s) => s.text.replace(/\s*(new|Unavailable|Manual)\s*$/, "")), expected, "every row is reached, in the order of the list");
      assert.equal(rows.length, 6);
      for (const s of stops) { assert.equal(s.outline, "solid", `no focus ring on ${s.id || s.text}`); assert.ok(s.width >= 2, `focus ring too thin on ${s.id || s.text}`); }

      // the loop above ended one Tab past the last row, so six Shift+Tab reach the first one again
      for (let i = 0; i < rows.length; i++) await app.page.keyboard.press("Shift+Tab");
      assert.match((await focused(app.page)).text, /^Alpha One/);
    });
  });

  test("Enter on a row opens its detail and the focus stays on that row; Space on the 'new' toggle narrows the list", async () => {
    await withApp({ width: 1440, height: 900 }, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      const row = link(app.page, /Alpha Two/); await row.waitFor();
      await row.focus();
      await app.page.keyboard.press("Enter");
      await detailOf(app.page).getByRole("heading", { name: "Alpha Two", level: 2 }).waitFor();
      assert.equal(await row.getAttribute("aria-current"), "true");
      assert.equal(await app.page.evaluate(() => (document.activeElement as HTMLElement).getAttribute("href")), hrefOf("alpha", "alpha-2"), "the keyboard user keeps their place");
      await app.page.keyboard.press("Tab");
      assert.equal((await focused(app.page)).tag, "A", "the next Tab reaches the next row, not the top of the page");

      await app.page.getByRole("button", { name: "Only new models" }).focus();
      await app.page.keyboard.press("Space");
      assert.deepEqual(await rowNames(app.page), ["Alpha One", "Beta One"]);
      await app.page.keyboard.press("Space");
      assert.deepEqual(await rowNames(app.page), ALL);
    });
  });
});

describe("models: axe", opts, () => {
  test("list and detail, light at 1440 px", async () => {
    await withApp({ width: 1440, height: 900 }, async (app) => {
      installCatalog(app.server.rpc, { warnings: [{ code: "role_unavailable", role: "default", provider: "alpha", id: "alpha-3" }] }); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      await expectAxeClean(app.page, "list");
      await link(app.page, /Beta Manual/).click();
      await detailOf(app.page).getByRole("heading", { name: "Beta Manual", level: 2 }).waitFor();
      await expectAxeClean(app.page, "detail of a manual model");
      await link(app.page, /Alpha One/).click();
      await detailOf(app.page).getByRole("heading", { name: "Alpha One", level: 2 }).waitFor();
      await expectAxeClean(app.page, "detail of a new model");
    });
  });

  test("list and detail, dark at 400 px (compact: one pane at a time)", async () => {
    await withApp({ colorScheme: "dark", width: 400, height: 900 }, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      await expectAxeClean(app.page, "compact list");
      await link(app.page, /Alpha Three/).click();
      await detailOf(app.page).getByRole("heading", { name: "Alpha Three", level: 2 }).waitFor();
      await expectAxeClean(app.page, "compact detail");
    });
  });

  test("the no-match state, a catalog with only the required fields and an unknown model route", async () => {
    await withApp({ width: 960, height: 900 }, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      await select(app.page, "#mf-provider", "gamma"); await select(app.page, "#mf-status", "manual");
      await app.page.getByText("No model matches the filters.").waitFor();
      await expectAxeClean(app.page, "no match");
      await app.page.evaluate((h) => { location.hash = h; }, hrefOf("alpha", "no-such-model"));
      await detailOf(app.page).getByText("This model is not in the catalog.").waitFor();
      await expectAxeClean(app.page, "model not in catalog");
    });
    await withApp({ width: 960, height: 900 }, async (app) => {
      installCatalog(app.server.rpc, { models: [requiredOnly(), { provider: "alpha", id: "bare" }], providers: [], newIds: new Set() }); await open(app, hrefOf("alpha", "plain"));
      await detailOf(app.page).getByRole("heading", { name: "Plain", level: 2 }).waitFor();
      await expectAxeClean(app.page, "required fields only");
    });
  });

  test("German list and detail", async () => {
    await withApp({ locale: "de-DE", width: 1440, height: 900 }, async (app) => {
      installCatalog(app.server.rpc); await open(app, hrefOf("alpha", "alpha-3"), "de");
      await app.page.getByRole("region", { name: "Modelldetails" }).getByRole("heading", { name: "Alpha Three", level: 2 }).waitFor();
      await expectAxeClean(app.page, "German list and detail");
    });
  });
});
