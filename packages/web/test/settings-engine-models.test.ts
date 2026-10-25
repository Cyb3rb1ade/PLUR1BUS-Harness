// Settings → Models & providers: the memory engine's models, read-only. They are not model roles: the engine takes them from
// engine.embedding and engine.reranker, so the section shows what core.status reports and how to change them, and offers no control.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { modelLine, readEngineModels } from "../src/pages/settings/config/engine.ts";
import { setLangPref } from "../src/i18n.ts";
import { expectAxeClean } from "./axe.ts";
import { CORE_OK } from "./doctor-fixtures.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { installCatalog } from "./models-fixtures.ts";
import { seedConfig } from "./settings-config-fixtures.ts";

before(setup); after(teardown);
const opts = { skip: browserSkip };
const ENGINE = {
  embedder: { state: "ready", warming: false, checkedAt: 1, id: "intfloat/multilingual-e5-small" },
  reranker: { state: "ready", warming: true, checkedAt: 1, id: "local-transformers" },
};
const coreStatus = (models: unknown): unknown => ({ ...CORE_OK, engine: { ...CORE_OK.engine, models } });

test("readEngineModels takes engine.models from a core.status answer and drops what is not a model status", () => {
  assert.equal(readEngineModels(null), null);
  assert.equal(readEngineModels("ready"), null);
  assert.equal(readEngineModels({ process: { state: "ready" } }), null, "no engine object: not a core status");
  assert.deepEqual(readEngineModels({ engine: { ready: false, degraded: null } }), {}, "the engine has not reported its models yet");
  assert.deepEqual(readEngineModels(CORE_OK), { embedder: { state: "ready", warming: false, id: "e5" }, reranker: { state: "disabled", warming: false, id: null } });
  assert.deepEqual(readEngineModels({ engine: { models: { embedder: { state: 7, id: "x" }, reranker: { state: "failed", warming: "yes", id: 5 } } } }),
    { reranker: { state: "failed", warming: false, id: null } });
});

test("modelLine names the model and its state", () => {
  setLangPref("en");
  assert.equal(modelLine({ state: "ready", warming: false, id: "intfloat/multilingual-e5-small" }), "intfloat/multilingual-e5-small (ready)");
  assert.equal(modelLine({ state: "loading", warming: true, id: "local-transformers" }), "local-transformers (loading, warming up)");
  assert.equal(modelLine({ state: "disabled", warming: false, id: null }), "disabled");
  assert.equal(modelLine({ state: "melting", warming: false, id: "x" }), "x (unknown)");
  assert.equal(modelLine(undefined), "not reported yet");
});

test("the section shows the engine's embedding model and reranker read-only, with the way to change them; axe and 400 px", opts, async () => {
  await withApp({ width: 400, height: 900 }, async (app) => {
    seedConfig(app.server.rpc); installCatalog(app.server.rpc);
    app.server.rpc.handle("core.status", () => coreStatus(ENGINE), { write: false });
    await openRoute(app.page, "#/settings/models");
    const engine = app.page.getByRole("group", { name: "Memory engine models" });
    await engine.getByText("intfloat/multilingual-e5-small (ready)").waitFor();
    const text = await engine.innerText();
    assert.match(text, /Embedding model\s+intfloat\/multilingual-e5-small \(ready\)/);
    assert.match(text, /Reranker\s+local-transformers \(ready, warming up\)/);
    assert.match(text, /engine\.embedding/);
    assert.match(text, /plur1bus memory reembed/);
    assert.equal(await engine.getByRole("link", { name: "Open first-run setup" }).getAttribute("href"), "#/setup");
    assert.equal(await engine.locator("input, select, textarea, button").count(), 0, "nothing to edit");
    await expectAxeClean(app.page, "engine models 400px");
    assert.ok(await app.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  });
});

test("a failing core.status leaves the section usable and says the engine status is unavailable", opts, async () => {
  await withApp({}, async (app) => {
    seedConfig(app.server.rpc); installCatalog(app.server.rpc);
    app.server.rpc.handle("core.status", () => coreStatus(ENGINE), { write: false });
    app.server.rpc.scenario("core.status", "error");
    await openRoute(app.page, "#/settings/models");
    const engine = app.page.getByRole("group", { name: "Memory engine models" });
    await engine.waitFor();
    assert.equal(await app.page.locator("#cfg-modelRoles-chat").isEnabled(), true);
    assert.match(await engine.innerText(), /The engine status could not be read\./);
    assert.match(await engine.innerText(), /plur1bus memory reembed/);
  });
});

test("a role without settings write sees the engine models but no link to first-run setup", opts, async () => {
  await withApp({ server: { role: "viewer" } }, async (app) => {
    seedConfig(app.server.rpc); installCatalog(app.server.rpc);
    app.server.rpc.handle("core.status", () => coreStatus(ENGINE), { write: false });
    await openRoute(app.page, "#/settings/models");
    const engine = app.page.getByRole("group", { name: "Memory engine models" });
    await engine.getByText("intfloat/multilingual-e5-small (ready)").waitFor();
    assert.equal(await engine.getByRole("link").count(), 0);
  });
});

test("German engine models", opts, async () => {
  await withApp({ locale: "de-DE" }, async (app) => {
    seedConfig(app.server.rpc); installCatalog(app.server.rpc);
    app.server.rpc.handle("core.status", () => coreStatus(ENGINE), { write: false });
    await openRoute(app.page, "#/settings/models", "de");
    const engine = app.page.getByRole("group", { name: "Modelle der Memory-Engine" });
    await engine.getByText("intfloat/multilingual-e5-small (bereit)").waitFor();
    assert.match(await engine.innerText(), /local-transformers \(bereit, wärmt auf\)/);
    assert.match(await engine.innerText(), /plur1bus memory reembed/);
    await engine.getByRole("link", { name: "Ersteinrichtung öffnen" }).waitFor();
  });
});
