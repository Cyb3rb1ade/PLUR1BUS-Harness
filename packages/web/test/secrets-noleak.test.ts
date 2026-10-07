// HARD REQUIREMENT: a secret value typed into the create or rotate dialog exists nowhere after saving except in the one
// secret.set request body: not in the DOM (markup, attributes, input values), console, storage, URL/history, or other requests.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { seedSecrets } from "./secrets-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const CANARY = "CANARY-7f3a91c2-do-not-leak";

async function scan(app: App, consoleLines: string[], where: string): Promise<void> {
  const { html, inputs, storage, url, state } = await app.page.evaluate(() => ({
    html: document.documentElement.outerHTML,
    inputs: [...document.querySelectorAll("input, textarea, select")].map((e) => (e as HTMLInputElement).value),
    storage: JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    url: location.href,
    state: JSON.stringify(history.state),
  }));
  assert.ok(!html.includes(CANARY), `${where}: canary in DOM`);
  assert.ok(inputs.every((v) => !v.includes(CANARY)), `${where}: canary in an input value`);
  assert.ok(!storage.includes(CANARY), `${where}: canary in web storage`);
  assert.ok(!url.includes(CANARY) && !state.includes(CANARY), `${where}: canary in URL or history`);
  assert.ok(consoleLines.every((l) => !l.includes(CANARY)), `${where}: canary in console`);
  // Properties are not markup: also walk the DOM for any attribute or property holding it.
  const props = await app.page.evaluate((c) => {
    const hits: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      for (const a of el.getAttributeNames()) if ((el.getAttribute(a) ?? "").includes(c)) hits.push(`${el.tagName}@${a}`);
      if (typeof (el as HTMLInputElement).value === "string" && (el as HTMLInputElement).value.includes(c)) hits.push(`${el.tagName}.value`);
    }
    return hits;
  }, CANARY);
  assert.deepEqual(props, [], `${where}: canary in element attributes/properties`);
  const withCanary = app.server.requests.filter((r) => r.body.includes(CANARY) || r.url.includes(CANARY));
  assert.equal(withCanary.length, 1, `${where}: canary in ${withCanary.length} requests`);
  assert.equal(withCanary[0]!.url, "/rpc");
  assert.equal((JSON.parse(withCanary[0]!.body) as { method: string }).method, "secret.set");
  const rpcWith = app.server.rpc.calls.filter((c) => JSON.stringify(c.params).includes(CANARY));
  assert.deepEqual(rpcWith.map((c) => c.method), ["secret.set"]);
}

describe("secrets: the value never leaks", opts, () => {
  for (const mode of ["create", "rotate"] as const) {
    test(`after ${mode}`, async () => {
      await withApp({}, async (app) => {
        const consoleLines: string[] = [];
        app.page.on("console", (m) => { consoleLines.push(m.text()); });
        app.page.on("pageerror", (e) => { consoleLines.push(String(e)); });
        seedSecrets(app.server.rpc); await openRoute(app.page, "#/settings/secrets");
        if (mode === "create") {
          await app.page.getByRole("button", { name: "Add secret" }).click();
          await app.page.getByRole("dialog").getByLabel("Name").fill("leak.test");
          await app.page.getByRole("dialog").getByLabel("Value").fill(CANARY);
          await app.page.getByRole("dialog").getByLabel("Show value while typing").check();
        } else {
          await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
          await app.page.getByRole("dialog").getByLabel("New value").fill(CANARY);
        }
        const submitting = app.page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
        await submitting;
        await app.page.getByRole("dialog").waitFor({ state: "detached" });
        await app.page.getByText(/^Saved /).waitFor();
        await scan(app, consoleLines, mode);
        // Reopen the dialog: nothing is prefilled.
        await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
        assert.equal(await app.page.getByRole("dialog").getByLabel("New value").inputValue(), "");
        await app.page.keyboard.press("Escape");
        await scan(app, consoleLines, `${mode} reopened`);
        assert.equal(app.problems.length, 0, app.problems.join("\n"));
      });
    });
  }

  test("after a failed save the value is gone from the input and the DOM too", async () => {
    await withApp({}, async (app) => {
      const consoleLines: string[] = [];
      app.page.on("console", (m) => { consoleLines.push(m.text()); });
      seedSecrets(app.server.rpc);
      app.server.rpc.handle("secret.set", () => { throw rpcError("E_STORAGE", "disk"); });
      await openRoute(app.page, "#/settings/secrets");
      await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByLabel("New value").fill(CANARY);
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByRole("alert").waitFor();
      await scan(app, consoleLines, "failed save");
    });
  });
});
