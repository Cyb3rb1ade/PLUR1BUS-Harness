// b20 audit: Usage & Quota limit dialog.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const usage = { events: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 2_000_000, unpricedEvents: 0 };

describe("usage: a new bound equal to the current use", opts, () => {
  test("a hard limit set to exactly what is used is exceeded at once (used >= bound), so it asks for the same confirmation as a lower one", async () => {
    await withApp({}, async (app) => {
      app.server.rpc.handle("budget.status", () => ({
        timeZone: "Europe/Berlin", priceVersion: "v1", now: "2026-10-07T09:00:00+02:00",
        periods: [{ period: "day", key: "2026-10-07", start: "2026-10-07T00:00:00+02:00", end: "2026-10-08T00:00:00+02:00", total: usage, agents: [] }],
        limits: [{ scope: "global", period: "day", metric: "cost", soft: null, hard: 10_000_000, used: 2_000_000, state: "ok" }],
      }), { write: false });
      await openRoute(app.page, "#/usage");
      await app.page.getByRole("button", { name: "Edit limit: Daily cost" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Edit limit: Daily cost" });
      await dlg.getByLabel("Hard limit").fill("2");
      await dlg.getByRole("button", { name: "Review" }).click();
      const review = app.page.getByRole("dialog", { name: "Confirm limit" });
      await review.waitFor();
      assert.equal(await review.getByRole("button", { name: "Confirm and save" }).isDisabled(), true, "saving a limit that is exceeded at once needs the confirmation");
    });
  });
});
