// b18 audit of the Memories page: a second click on a confirmed action that is still running must not send it twice.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { defaultFixture, installMemoryMocks } from "./memory-fixtures.ts";
import { seedMedia } from "./media-search-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);
/** Two clicks in the same task, before the page could re-render: what a fast double click does. */
const clickTwice = (loc: ReturnType<App["page"]["locator"]>) => loc.evaluate((el) => { (el as HTMLElement).click(); (el as HTMLElement).click(); });

describe("memories: a double click sends one request", opts, () => {
  test("Run now in the dialog starts one run", async () => {
    await withApp({}, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      await openRoute(app.page, "#/memories/dreams");
      await app.page.getByRole("group", { name: "Light", exact: true }).getByRole("button", { name: "Run now" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByText("The guards allow this run").waitFor();
      app.server.rpc.setDelay("dreams.run", 300);
      await clickTwice(dlg.getByRole("button", { name: "Run now" }));
      await app.page.getByRole("status").filter({ hasText: "finished as run" }).waitFor();
      assert.equal(calls(app, "dreams.run").filter((c) => !(c.params as { dryRun?: boolean }).dryRun).length, 1);
    });
  });

  test("Disable in the dialog sends one request", async () => {
    await withApp({}, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      await openRoute(app.page, "#/memories/dreams");
      await app.page.getByRole("group", { name: "Light", exact: true }).getByRole("button", { name: "Disable" }).click();
      const dlg = app.page.getByRole("dialog");
      app.server.rpc.setDelay("dreams.disable", 300);
      await clickTwice(dlg.getByRole("button", { name: "Disable" }));
      await app.page.getByRole("status").filter({ hasText: /disabled/i }).waitFor();
      assert.equal(calls(app, "dreams.disable").length, 1);
    });
  });

  test("Pause on the Media tab sends one request", async () => {
    await withApp({}, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      seedMedia(app.server.rpc, {});
      await openRoute(app.page, "#/memories/media");
      const pause = app.page.getByRole("button", { name: "Pause", exact: true });
      await pause.waitFor();
      app.server.rpc.setDelay("media.index.pause", 300);
      await clickTwice(pause);
      await app.page.waitForTimeout(800);
      assert.equal(calls(app, "media.index.pause").length, 1);
    });
  });

  // components/confirm-dialog.ts guards with state only (outside this module): the same-task double click gets through.
  test("KNOWN GAP: the typed re-index confirmation sends one request", { todo: "ConfirmDialog guards with state, not a ref (src/components, not b18's module)" }, async () => {
    await withApp({}, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      seedMedia(app.server.rpc, {});
      await openRoute(app.page, "#/memories/media");
      await app.page.getByRole("button", { name: "Re-index", exact: false }).first().click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByRole("textbox").fill("reindex");
      app.server.rpc.setDelay("media.index.reindex", 300);
      await clickTwice(dlg.getByRole("button", { name: /Re-index|Reindex/ }).last());
      await app.page.waitForTimeout(800);
      assert.equal(calls(app, "media.index.reindex").length, 1);
    });
  });
});
