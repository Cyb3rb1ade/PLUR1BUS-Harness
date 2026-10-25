// Setup wizard while a step is being saved (audit c20): Back and Skip must not move the person while saving (the
// finished save would then move them on from the wrong step), and a burst of clicks on Next sends one request.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, setup, teardown, withApp } from "./harness.ts";
import { calls, next, open, seed, stepHeading, toPersona } from "./setup-fixtures.ts";

before(setup);
after(teardown);

describe("setup wizard: a save in flight", { skip: browserSkip }, () => {
  test("Back and Skip are disabled while Next is saving, and the person lands on the next step, not on a stale one", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toPersona(app);
      await page.getByLabel("Display name").fill("Hal");
      await next(page);
      await stepHeading(page, /Main model/).waitFor();
      await page.getByLabel("Chat model").selectOption("anthropic/claude-x");
      app.server.rpc.setDelay("config.set", 700);
      await next(page);
      const back = page.getByRole("button", { name: "Back" });
      await page.getByRole("button", { name: "Saving…" }).waitFor();
      assert.equal(await back.isDisabled(), true, "Back is disabled while saving");
      assert.equal(await page.getByRole("button", { name: "Skip this step" }).isDisabled(), true, "Skip is disabled while saving");
      await stepHeading(page, /Decision model/).waitFor();
      assert.equal(calls(app, "config.set").length, 1);
      assert.equal(calls(app, "agent.create").length, 1);
    });
  });

  test("two clicks on Next in the same tick send one agent.create", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toPersona(app);
      await page.getByLabel("Display name").fill("Hal");
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent === "Next")!;
        b.click(); b.click();
      });
      await stepHeading(page, /Main model/).waitFor();
      assert.equal(calls(app, "agent.create").length, 1);
    });
  });
});
