import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { installMemoryMocks } from "./memory-fixtures.ts";
import { installCatalog } from "./models-fixtures.ts";
import { expectAxeClean } from "./axe.ts";

before(setup); after(teardown);
const opts = { skip: browserSkip };
for (const route of ["#/models", "#/memories"]) test(`${route}: explicit role probes, result, failure and axe`, opts, async () => {
  await withApp({}, async app => {
    installCatalog(app.server.rpc); installMemoryMocks(app.server);
    app.server.rpc.handle("admin.engine.test", p => (p as any).role === "embedder" ? { role: "embedder", ok: true, model: "local/e5", dimensions: 384, durationMs: 42 } : { role: "reranker", ok: false, durationMs: 12, errorClass: "egress" });
    app.server.rpc.setDelay("admin.engine.test", 200);
    await openRoute(app.page, route);
    const card = app.page.getByRole("group", { name: "Engine model tests", exact: true });
    await card.waitFor();
    assert.equal(app.server.rpc.calls.filter(c => c.method === "admin.engine.test").length, 0);
    await card.getByRole("button", { name: "Test embedder", exact: true }).click();
    assert.equal(await card.getByRole("button", { name: "Testing embedder…" }).isDisabled(), true);
    await card.getByText("384 dimensions", { exact: false }).waitFor();
    assert.ok((await card.textContent())?.includes("42 ms"));
    await card.getByRole("button", { name: "Test reranker", exact: true }).click();
    await card.getByText("Outgoing network policy blocked this test.", { exact: true }).waitFor();
    const calls = app.server.rpc.calls.filter(c => c.method === "admin.engine.test");
    assert.deepEqual(calls.map(c => c.params), [{ role: "embedder" }, { role: "reranker" }]);
    assert.ok(calls.every(c => c.csrf));
    await card.getByText("This engine has no captioner role.", { exact: true }).waitFor();
    await expectAxeClean(app.page, route + " engine tests"); assert.deepEqual(app.problems, []);
  });
});
test("German role tests and safe provider failure text", opts, async () => {
  await withApp({ locale: "de-DE" }, async app => {
    installMemoryMocks(app.server);
    app.server.rpc.handle("admin.engine.test", () => ({ role: "reranker", ok: false, durationMs: 1, errorClass: "key", detail: "private-fixture-credential" }));
    await openRoute(app.page, "#/memories", "de");
    await app.page.getByRole("button", { name: "Reranker testen", exact: true }).click();
    await app.page.getByText("Der konfigurierte Schlüssel ist nicht verfügbar.", { exact: true }).waitFor();
    assert.ok(!(await app.page.locator("main").textContent())?.includes("private-fixture-credential"));
    await expectAxeClean(app.page, "German engine role failure");
  });
});
for (const role of ["viewer", "operator", "member"]) test(`${role}: no engine probe controls or calls`, opts, async () => {
  await withApp({ server: { role } }, async app => {
    installMemoryMocks(app.server);
    await openRoute(app.page, "#/memories");
    await app.page.getByRole("heading", { name: "Memories & Dreams", exact: true }).waitFor();
    assert.equal(await app.page.getByRole("button", { name: /Test (embedder|reranker)/ }).count(), 0);
    assert.equal(app.server.rpc.calls.filter(c => c.method === "admin.engine.test").length, 0);
  });
});
