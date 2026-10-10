// The sign-in page beyond the happy path and the wrong token (e2e.test.ts covers those): a server error on the login
// request, keyboard submit and reveal, and the German copy. The mock answers only POST /api/v1/session with the error;
// every other route stays on the built-in mock, so the shell can still load.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { browserSkip, setup, teardown, withApp, TOKEN, type App } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

/** Answers the sign-in POST with `status` and nothing else; returns false for every other request. */
function failLogin(app: App, status: number): void {
  app.server.extensions.unshift((req: IncomingMessage, res: ServerResponse, path: string) => {
    if (path !== "/api/v1/session" || req.method !== "POST") return false;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "E_INTERNAL", message: "boom" } }));
    return true;
  });
}

describe("sign-in: keyboard and server errors", opts, () => {
  test("a 500 on sign-in shows the status, keeps the user on the page and clears the token field", async () => {
    await withApp({}, async (app) => {
      failLogin(app, 500);
      await app.page.getByLabel("Owner token", { exact: true }).waitFor();
      await app.page.getByLabel("Owner token", { exact: true }).fill(TOKEN);
      await app.page.getByRole("button", { name: "Sign in" }).click();
      const alert = app.page.getByRole("alert").filter({ hasText: "answered with an error (500)" });
      await alert.waitFor();
      assert.match(app.page.url(), /#\/login$/);
      assert.equal(await app.page.getByLabel("Owner token", { exact: true }).inputValue(), "", "the token never stays in the field");
      assert.equal(await app.page.evaluate(() => document.activeElement?.id), "login-token", "focus returns to the field");
    });
  });

  test("Enter in the token field signs in without touching the button", async () => {
    await withApp({}, async (app) => {
      await app.page.getByLabel("Owner token", { exact: true }).waitFor();
      await app.page.getByLabel("Owner token", { exact: true }).fill(TOKEN);
      await app.page.keyboard.press("Enter");
      await app.page.locator(".sidebar").waitFor();
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });

  test("Enter with an empty field shows the required message and keeps focus in the field", async () => {
    await withApp({}, async (app) => {
      await app.page.getByLabel("Owner token", { exact: true }).waitFor();
      await app.page.keyboard.press("Enter");
      await app.page.getByRole("alert").filter({ hasText: "Enter the owner token." }).waitFor();
      assert.equal(await app.page.evaluate(() => document.activeElement?.id), "login-token");
      assert.equal(await app.page.getByLabel("Owner token", { exact: true }).getAttribute("aria-invalid"), "true");
    });
  });

  test("Tab from the field reaches the reveal button; Enter there switches the field to plain text and back", async () => {
    await withApp({}, async (app) => {
      await app.page.getByLabel("Owner token", { exact: true }).waitFor();
      await app.page.getByLabel("Owner token", { exact: true }).focus();
      await app.page.keyboard.press("Tab");
      assert.equal(await app.page.evaluate(() => document.activeElement?.tagName), "BUTTON");
      await app.page.keyboard.press("Enter");
      assert.equal(await app.page.getByLabel("Owner token", { exact: true }).getAttribute("type"), "text");
      await app.page.keyboard.press("Enter");
      assert.equal(await app.page.getByLabel("Owner token", { exact: true }).getAttribute("type"), "password");
    });
  });
});

describe("sign-in: German", opts, () => {
  test("the page reads in German from the browser language and its errors are German too", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      await app.page.getByRole("heading", { name: "Anmelden", level: 1 }).waitFor();
      await app.page.getByLabel("Owner-Token", { exact: true }).waitFor();
      await app.page.getByRole("button", { name: "Anmelden" }).click();
      await app.page.getByRole("alert").filter({ hasText: "Gib das Owner-Token ein." }).waitFor();
    });
  });

  test("a 500 is reported in German with the status", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      failLogin(app, 500);
      await app.page.getByLabel("Owner-Token", { exact: true }).fill(TOKEN);
      await app.page.getByRole("button", { name: "Anmelden" }).click();
      await app.page.getByRole("alert").filter({ hasText: "Die Harness meldet einen Fehler (500)." }).waitFor();
    });
  });
});
