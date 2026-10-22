import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { browserSkip, setup, teardown, withApp, openRoute } from "./harness.ts";
import { defaultFixture, installMemoryMocks } from "./memory-fixtures.ts";
import { expectAxeClean } from "./axe.ts";

before(setup); after(teardown);
const opts = { skip: browserSkip };
const id = "mem_0123456789abcdefabcd";
for (const lang of ["en", "de"] as const) {
  test(`human curation is separate from proposals, escaped, confirmed and accessible (${lang})`, opts, async () => {
    await withApp({ locale: lang === "de" ? "de-DE" : "en-US" }, async app => {
      installMemoryMocks(app.server, defaultFixture());
      let resolved = false;
      app.server.rpc.handle("memory.curation.list", () => ({ agentId: "main", items: resolved ? [] : [{ id, status: "conflict", text: "Evidence <img src=x onerror=alert(1)>", category: null }], truncated: false }));
      app.server.rpc.handle("memory.curation.resolve", () => { resolved = true; return { agentId: "main", id, status: "promoted" }; });
      await openRoute(app.page, "#/memories/curation", lang);
      const evidence = app.page.getByText("Evidence <img src=x onerror=alert(1)>", { exact: true });
      await evidence.waitFor({ timeout: 5000 });
      assert.equal(await app.page.locator(".tabpanel img").count(), 0);
      await app.page.getByRole("button", { name: lang === "de" ? "Behalten" : "Keep", exact: true }).click();
      assert.equal(app.server.rpc.calls.filter(c => c.method === "memory.curation.resolve").length, 0);
      await expectAxeClean(app.page, `curation confirmation ${lang}`);
      await app.page.getByRole("button", { name: lang === "de" ? "Bestätigen" : "Confirm", exact: true }).click();
      await evidence.waitFor({ state: "detached" });
      assert.deepEqual(app.server.rpc.calls.find(c => c.method === "memory.curation.resolve")?.params, { agentId: "main", id, action: "keep" });
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });
}

test("a refused curation read exposes no evidence and keeps other memory tabs usable", opts, async () => {
  await withApp({}, async app => {
    installMemoryMocks(app.server, defaultFixture());
    app.server.rpc.handle("memory.curation.list", () => ({ agentId: "main", items: [], truncated: false }));
    app.server.rpc.scenario("memory.curation.list", "forbidden");
    await openRoute(app.page, "#/memories/curation");
    await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
    assert.equal(await app.page.getByText("Evidence", { exact: true }).count(), 0);
    await app.page.getByRole("tab", { name: "Memories", exact: true }).click();
    await app.page.getByRole("tab", { name: "Memories", exact: true }).waitFor();
  });
});

test("drop cancellation writes nothing and a refused confirmed drop keeps the evidence unresolved", opts, async () => {
  await withApp({}, async app => {
    installMemoryMocks(app.server, defaultFixture());
    const evidence = "Evidence stays until the Engine confirms drop";
    app.server.rpc.handle("memory.curation.list", () => ({ agentId: "main", items: [{ id, status: "conflict", text: evidence, category: null }], truncated: false }));
    app.server.rpc.handle("memory.curation.resolve", () => ({ agentId: "main", id, status: "demoted" }));
    app.server.rpc.scenario("memory.curation.resolve", "forbidden");
    await openRoute(app.page, "#/memories/curation");
    await app.page.getByText(evidence, { exact: true }).waitFor();
    await app.page.getByRole("button", { name: "Drop", exact: true }).click();
    await app.page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(app.server.rpc.calls.filter(c => c.method === "memory.curation.resolve").length, 0);
    await app.page.getByRole("button", { name: "Drop", exact: true }).click();
    await app.page.getByRole("button", { name: "Confirm", exact: true }).click();
    await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
    assert.ok(await app.page.getByText(evidence, { exact: true }).isVisible());
    assert.ok(await app.page.getByRole("button", { name: "Confirm", exact: true }).isDisabled());
    assert.deepEqual(app.server.rpc.calls.find(c => c.method === "memory.curation.resolve")?.params, { agentId: "main", id, action: "drop" });
    await expectAxeClean(app.page, "curation refused drop");
  });
});
