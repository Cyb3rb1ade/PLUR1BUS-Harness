// Media view states and keyboard use, against the mock RPC: a search that finds nothing (English and German), Enter in the
// search field submits, and a search that the server answers with an empty list keeps the query in the field.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seedMedia } from "./media-search-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const open = (app: App, lang: "en" | "de" = "en"): Promise<void> => openRoute(app.page, "#/media", lang);
const searchField = (app: App): ReturnType<App["page"]["getByLabel"]> => app.page.getByLabel("Describe what you are looking for");

describe("media search: no hits and keyboard", opts, () => {
  test("a search with no hits says so in a status line and shows no result list", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc);
      app.server.rpc.handle("media.search", () => ({ hits: [] }));
      await open(app);
      await searchField(app).fill("nothing like this");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByRole("status").filter({ hasText: "No media matched this search." }).waitFor();
      assert.equal(await app.page.locator(".media-hits").count(), 0);
      assert.equal(await searchField(app).inputValue(), "nothing like this", "the query stays in the field");
    });
  });

  test("the empty result is German in German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedMedia(app.server.rpc);
      app.server.rpc.handle("media.search", () => ({ hits: [] }));
      await open(app, "de");
      await app.page.getByLabel("Beschreib, was du suchst").fill("nichts");
      await app.page.getByRole("button", { name: "Suchen", exact: true }).click();
      await app.page.getByRole("status").filter({ hasText: "Kein Medium passt zu dieser Suche." }).waitFor();
    });
  });

  test("Enter in the search field runs the search, as the button does", async () => {
    await withApp({}, async (app) => {
      const f = seedMedia(app.server.rpc);
      await open(app);
      await searchField(app).fill("forest");
      await searchField(app).press("Enter");
      await app.page.getByText("3 results").waitFor();
      assert.equal(f.searches.length, 1);
      assert.deepEqual(f.searches[0], { text: "forest", limit: 20 });
    });
  });

  test("Enter with an empty query asks for a description and sends nothing", async () => {
    await withApp({}, async (app) => {
      const f = seedMedia(app.server.rpc);
      await open(app);
      await searchField(app).press("Enter");
      await app.page.getByText("Enter a description or pick a medium").waitFor();
      assert.equal(f.searches.length, 0);
    });
  });

  test("a failing search can be retried from the keyboard once the server answers again", async () => {
    await withApp({}, async (app) => {
      const f = seedMedia(app.server.rpc, { searchError: "E_MEDIA_CAPABILITY" });
      await open(app);
      await searchField(app).fill("rain");
      await searchField(app).press("Enter");
      await app.page.getByText("cannot handle this kind of media").waitFor();
      // The server recovers: a new handler answers the same search with the normal hits.
      app.server.rpc.handle("media.search", (p) => { f.searches.push(p); return { hits: [] }; });
      await searchField(app).press("Enter");
      await app.page.getByRole("status").filter({ hasText: "No media matched this search." }).waitFor();
      assert.equal(f.searches.length, 2);
    });
  });
});
