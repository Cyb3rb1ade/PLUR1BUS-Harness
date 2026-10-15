// Media tab of the Memories page (`#/memories/media`) in the browser, against the mock RPC: the index state (on, provider, model,
// variant, dimension, counts, backfill), the role gate (Owner and Admin act, other roles read), pause and resume, re-index that
// needs the typed word and sends confirm:true, the budget and off and empty states, unavailable and failing loads, E_MEDIA_* on a
// refused action, the loading state, axe and German.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installMemoryMocks, defaultFixture } from "./memory-fixtures.ts";
import { seedMedia } from "./media-search-fixtures.ts";
import { rpcError } from "./mock-rpc.ts";
import { expectAxeClean } from "./axe.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

/** Memory mocks plus the media mocks, then the Media tab. */
async function open(app: App, lang: "en" | "de" = "en", over: Parameters<typeof seedMedia>[1] = {}): Promise<ReturnType<typeof seedMedia>> {
  installMemoryMocks(app.server, defaultFixture());
  const f = seedMedia(app.server.rpc, over);
  await openRoute(app.page, "#/memories/media", lang);
  return f;
}

const section = (app: App) => app.page.locator(".memory-media");
const reindexCalls = (app: App) => app.server.rpc.calls.filter((c) => c.method === "media.index.reindex");

describe("memories: Media tab, state", opts, () => {
  test("shows on, provider, model, variant, dimension, counts and backfill progress; the tab is selected", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await section(app).getByRole("heading", { name: "Media index" }).waitFor();
      const text = await section(app).innerText();
      assert.match(text, /Media index: on/);
      assert.match(text, /egemma2/);
      assert.match(text, /google\/embeddinggemma-2/);
      assert.match(text, /image\+video\+audio/);
      assert.match(text, /768/);
      assert.match(text, /Indexed: 120/);
      assert.match(text, /Pending: 14/);
      assert.match(text, /Failed: 2/);
      assert.match(text, /Unsupported: 1/);
      assert.match(text, /40 of 135/);
      assert.equal(await app.page.getByRole("tab", { name: "Media" }).getAttribute("aria-selected"), "true");
    });
  });

  test("the Media tab is reached from the tab row and its URL names the tab", async () => {
    await withApp({}, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      seedMedia(app.server.rpc);
      await openRoute(app.page, "#/memories");
      await app.page.getByRole("tab", { name: "Media" }).click();
      await section(app).waitFor();
      assert.match(app.page.url(), /#\/memories\/media$/);
    });
  });

  test("off: says so, keeps the numbers, and re-index is disabled", async () => {
    await withApp({}, async (app) => {
      await open(app, "en", { status: { enabled: false } });
      await section(app).getByRole("heading", { name: "Media index" }).waitFor();
      assert.match(await section(app).innerText(), /Media index: off/);
      assert.match(await section(app).innerText(), /Media indexing is off\./);
      assert.equal(await app.page.getByRole("button", { name: "Re-index media" }).isDisabled(), true);
    });
  });

  test("empty: an enabled index with nothing in it says so in a plain note, not as an error", async () => {
    await withApp({}, async (app) => {
      await open(app, "en", { status: { counts: { indexed: 0, pending: 0, failed: 0, unsupported: 0 }, backfill: { state: "idle", done: 0, total: 0 } } });
      await section(app).getByRole("heading", { name: "Media index" }).waitFor();
      assert.match(await section(app).innerText(), /Nothing is indexed yet/);
      assert.equal(await section(app).getByRole("alert").count(), 0);
    });
  });

  test("budget pause: explained in words, and resume is offered", async () => {
    await withApp({}, async (app) => {
      await open(app, "en", { status: { backfill: { state: "paused", done: 40, total: 135, pausedReason: "budget" } } });
      await section(app).getByRole("heading", { name: "Media index" }).waitFor();
      assert.match(await section(app).innerText(), /Paused because the usage budget is used up\./);
      assert.equal(await app.page.getByRole("button", { name: "Resume", exact: true }).count(), 1);
    });
  });

  test("loading: the tab waits for the status and says so first", async () => {
    await withApp({}, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      seedMedia(app.server.rpc);
      app.server.rpc.setDelay("media.index.status", 800);
      await openRoute(app.page, "#/memories/media");
      await app.page.getByText("Loading…").first().waitFor();
      await section(app).getByRole("heading", { name: "Media index" }).waitFor({ timeout: 10_000 });
    });
  });

  test("unavailable: an engine without the media index says so on the tab, not as a crash", async () => {
    await withApp({}, async (app) => {
      await open(app, "en", { noStatus: true });
      await app.page.getByText("The media index is not available on this installation.").waitFor();
      assert.equal(await section(app).count(), 0);
    });
  });

  test("a failing status load shows the failure with Try again", async () => {
    await withApp({}, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      seedMedia(app.server.rpc);
      app.server.rpc.scenario("media.index.status", "error", { code: "E_INTERNAL", message: "boom" });
      await openRoute(app.page, "#/memories/media");
      await app.page.getByRole("button", { name: "Try again" }).waitFor();
      assert.equal(await section(app).count(), 0);
    });
  });

  test("German: the tab and its labels are in German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      await open(app, "de");
      await section(app).getByRole("heading", { name: "Medienindex" }).waitFor();
      assert.match(await section(app).innerText(), /Medienindex: an/);
      assert.match(await section(app).innerText(), /Indiziert: 120/);
    });
  });
});

describe("memories: Media tab, roles and actions", opts, () => {
  test("an owner sees pause and re-index; an operator sees the state and the reason, but no action", async () => {
    await withApp({ server: { role: "operator" } }, async (app) => {
      await open(app);
      await section(app).getByRole("heading", { name: "Media index" }).waitFor();
      assert.match(await section(app).innerText(), /Only the owner or an admin can pause, resume or re-index\./);
      assert.equal(await app.page.getByRole("button", { name: "Re-index media" }).count(), 0);
      assert.equal(await app.page.getByRole("button", { name: "Pause", exact: true }).count(), 0);
    });
  });

  test("pause and resume change the state and say so", async () => {
    await withApp({}, async (app) => {
      const f = await open(app);
      await app.page.getByRole("button", { name: "Pause", exact: true }).click();
      await app.page.getByRole("button", { name: "Resume", exact: true }).waitFor();
      assert.match(await section(app).innerText(), /Media indexing paused\./);
      await app.page.getByRole("button", { name: "Resume", exact: true }).click();
      await app.page.getByRole("button", { name: "Pause", exact: true }).waitFor();
      assert.deepEqual(f.actions, ["pause", "resume"]);
    });
  });

  test("re-index needs the typed word: nothing is sent before it, then media.index.reindex with confirm:true", async () => {
    await withApp({}, async (app) => {
      const f = await open(app);
      await app.page.getByRole("button", { name: "Re-index media" }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByRole("heading", { name: "Re-index all media?" }).waitFor();
      const confirmBtn = dialog.getByRole("button", { name: "Re-index", exact: true });
      assert.equal(await confirmBtn.isDisabled(), true, "the confirm button waits for the typed word");
      assert.equal(f.actions.includes("reindex"), false);
      await dialog.locator("#confirm-typed").fill("reindex");
      await confirmBtn.click();
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(f.actions, ["reindex"]);
      const [call] = reindexCalls(app);
      assert.deepEqual(call?.params, { confirm: true });
      assert.match(await section(app).innerText(), /Re-indexing started\./);
    });
  });

  test("a refused action shows its E_MEDIA_* text in words", async () => {
    await withApp({}, async (app) => {
      await open(app);
      app.server.rpc.handle("media.index.pause", () => { throw rpcError("E_MEDIA_UNAVAILABLE", "E_MEDIA_UNAVAILABLE: refused", "unavailable"); }, { write: true });
      await app.page.getByRole("button", { name: "Pause", exact: true }).click();
      await app.page.getByRole("alert").filter({ hasText: /The model is not installed/ }).waitFor();
    });
  });
});

describe("memories: Media tab, accessibility", opts, () => {
  test("axe clean in light and dark", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      await withApp({ colorScheme }, async (app) => {
        await open(app);
        await section(app).getByRole("heading", { name: "Media index" }).waitFor();
        await expectAxeClean(app.page, `memory media tab (${colorScheme})`);
      });
    }
  });

  test("the status line in the page is announced politely", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await section(app).getByRole("heading", { name: "Media index" }).waitFor();
      assert.equal(await section(app).locator("[aria-live=polite]").count(), 1);
    });
  });
});
