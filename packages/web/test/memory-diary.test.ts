import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { expectAxeClean } from "./axe.ts";
import { defaultFixture, installMemoryMocks } from "./memory-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const text = "# DREAMS\nA blue bridge <img src=x onerror=alert(1)>\nSecond line.";

for (const lang of ["en", "de"] as const) {
  test(`diary is read on demand and displays escaped multiline content (${lang})`, opts, async () => {
    await withApp({ locale: lang === "de" ? "de-DE" : "en-US" }, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      app.server.rpc.handle("dreams.diary", () => ({ agentId: "main", path: "/home/main/DREAMS.md", exists: true, bytes: Buffer.byteLength(text), text, truncated: true }));
      await openRoute(app.page, "#/memories/dreams", lang);
      await app.page.getByRole("group", { name: "main", exact: true }).waitFor();
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "dreams.diary").length, 0);
      await app.page.getByRole("button", { name: lang === "de" ? "Tagebuch lesen" : "Read diary", exact: true }).click();
      const content = app.page.getByLabel(lang === "de" ? "Traumtagebuch" : "Dream diary", { exact: true });
      await content.waitFor();
      assert.equal(await content.textContent(), text);
      assert.equal(await content.locator("img").count(), 0);
      await app.page.getByText(lang === "de" ? "Das Tagebuch ist gekürzt." : "The diary is truncated.", { exact: true }).waitFor();
      assert.deepEqual(app.server.rpc.calls.find((c) => c.method === "dreams.diary")?.params, { agentId: "main" });
      await expectAxeClean(app.page);
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });
}

test("a refused diary request exposes no diary text and leaves phase status available", opts, async () => {
  await withApp({}, async (app) => {
    installMemoryMocks(app.server, defaultFixture());
    app.server.rpc.handle("dreams.diary", () => ({ agentId: "main", path: "/home/main/DREAMS.md", exists: true, bytes: text.length, text, truncated: false }));
    app.server.rpc.scenario("dreams.diary", "forbidden");
    await openRoute(app.page, "#/memories/dreams");
    await app.page.getByRole("button", { name: "Read diary", exact: true }).click();
    await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
    assert.equal(await app.page.locator('pre[aria-label="Dream diary"]').count(), 0);
    await app.page.getByRole("group", { name: "Light", exact: true }).waitFor();
  });
});

for (const exists of [false, true]) {
  test(`diary distinguishes ${exists ? "empty" : "missing"} output`, opts, async () => {
    await withApp({}, async (app) => {
      installMemoryMocks(app.server, defaultFixture());
      app.server.rpc.handle("dreams.diary", () => ({ agentId:"main", path:"/home/main/DREAMS.md", exists, bytes:0, text:"", truncated:false }));
      await openRoute(app.page,"#/memories/dreams");
      await app.page.getByRole("button",{name:"Read diary",exact:true}).click();
      await app.page.getByText(exists ? "The diary is empty." : "Diary missing",{exact:true}).waitFor();
      assert.equal(await app.page.locator('pre[aria-label="Dream diary"]').count(),0);
    });
  });
}
