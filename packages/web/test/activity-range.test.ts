// Activity tab, time range (Schritt 2): the range select sends `from` to logs.query, "All" sends nothing extra.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installActivity, NOW } from "./activity-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function open(app: App, lang: "en" | "de" = "en"): Promise<void> {
  installActivity(app.server);
  await app.page.clock.setFixedTime(NOW);
  await openRoute(app.page, "#/logs/activity", lang);
  await app.page.getByLabel(lang === "de" ? "Zeitraum" : "Time range").waitFor();
}

const queries = (app: App) =>
  app.server.rpc.calls.filter((c) => c.method === "logs.query").map((c) => c.params as Record<string, unknown>);

describe("activity: time range", opts, () => {
  test("the default is all time: logs.query gets no lower bound", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const qs = queries(app);
      assert.ok(qs.length > 0);
      for (const q of qs) assert.equal("from" in q, false);
      assert.equal(await app.page.getByLabel("Time range").inputValue(), "all");
    });
  });

  test("choosing Last 24 hours reloads with from = now minus 24 h, on every stream", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const before = queries(app).length;
      await app.page.getByLabel("Time range").selectOption("24h");
      // The mock server runs in this process, so poll its call log rather than the page.
      for (let i = 0; i < 50 && queries(app).length < before + 2; i++) await new Promise((r) => setTimeout(r, 100));
      const fresh = queries(app).slice(before);
      assert.deepEqual(fresh.map((q) => q.stream).sort(), ["audit", "diagnostic"]);
      const want = new Date(NOW - 86_400_000).toISOString();
      for (const q of fresh) assert.equal(q.from, want);
    });
  });

  test("the range is labelled and translated in German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      await open(app, "de");
      await app.page.getByLabel("Zeitraum").selectOption("30d");
      for (let i = 0; i < 50 && typeof queries(app).at(-1)?.from !== "string"; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(typeof queries(app).at(-1)?.from, "string");
    });
  });
});
