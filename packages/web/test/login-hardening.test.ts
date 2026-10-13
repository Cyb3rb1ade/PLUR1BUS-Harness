// The sign-in page hardened: one neutral failure text, the wait time of a rate limit or lockout, autocomplete attributes, no
// inline styles or scripts (CSP), the field emptied after a failure, and nothing typed ever logged. The page signs in with the
// owner token only (SessionApi.login takes `{ token }`): there is no user name to confirm or deny.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, setup, teardown, withApp, WRONG_TOKEN, type App } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const CANARY = "CANARY-login-5c1d0e77-do-not-log";

/** Answers POST /api/v1/session with a fixed status, headers and JSON body; every other route stays on the mock. */
function answerLogin(app: App, status: number, headers: Record<string, string> = {}, body: unknown = { error: "E_UNAUTHORIZED" }): void {
  app.server.extensions.unshift((req: IncomingMessage, res: ServerResponse, path: string) => {
    if (path !== "/api/v1/session" || req.method !== "POST") return false;
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
    return true;
  });
}
const field = (app: App) => app.page.getByLabel("Owner token", { exact: true });
const submit = async (app: App, value: string): Promise<void> => { await field(app).fill(value); await app.page.getByRole("button", { name: "Sign in" }).click(); };

describe("sign-in: failure texts", opts, () => {
  test("any refusal reads the same and repeats nothing the server said or the user typed", async () => {
    const texts = new Set<string>();
    for (const value of [WRONG_TOKEN, "admin", "someone@example.com", CANARY]) {
      await withApp({}, async (app) => {
        answerLogin(app, 401, {}, { error: "E_UNAUTHORIZED", reason: "no-such-user", message: "user does not exist" });
        await field(app).waitFor();
        await submit(app, value);
        const alert = app.page.getByRole("alert").filter({ hasText: "not correct" });
        await alert.waitFor();
        const text = (await alert.innerText()).trim();
        texts.add(text);
        assert.ok(!text.includes(value) && !/no-such-user|does not exist|user/i.test(text), text);
        assert.ok(!(await app.page.content()).includes(CANARY));
      });
    }
    assert.deepEqual([...texts], ["The token is not correct."]);
  });

  test("a rate limit shows the wait in seconds, in minutes from two minutes on, and a fallback without one", async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ "retry-after": "30" }, /^Too many attempts\. Try again in 30 s\.$/],
      [{ "retry-after": "600" }, /^Too many attempts\. Try again in 10 min\.$/],
      [{ "retry-after": "125" }, /^Too many attempts\. Try again in 3 min\.$/],
      [{}, /^Too many attempts\. Try again in a moment\.$/],
      [{ "retry-after": "soon" }, /^Too many attempts\. Try again in a moment\.$/],
    ];
    for (const [headers, expected] of cases) {
      await withApp({}, async (app) => {
        answerLogin(app, 429, headers, { error: "E_DENIED", reason: "locked" }); // a lockout answers like a rate limit
        await field(app).waitFor();
        await submit(app, WRONG_TOKEN);
        const alert = app.page.getByRole("alert").filter({ hasText: "Too many attempts" });
        await alert.waitFor();
        assert.match((await alert.innerText()).trim(), expected);
        assert.ok(!(await alert.innerText()).includes("locked"), "the server's reason code is not shown");
      });
    }
  });

  test("a rate limit reads in German too", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      answerLogin(app, 429, { "retry-after": "300" });
      await app.page.getByLabel("Owner-Token", { exact: true }).fill(WRONG_TOKEN);
      await app.page.getByRole("button", { name: "Anmelden" }).click();
      await app.page.getByRole("alert").filter({ hasText: "Zu viele Versuche. Versuche es in 5 min erneut." }).waitFor();
    });
  });
});

describe("sign-in: the field", opts, () => {
  test("autocomplete says current-password, the field is masked and never prefilled", async () => {
    await withApp({}, async (app) => {
      await field(app).waitFor();
      assert.equal(await field(app).getAttribute("autocomplete"), "current-password");
      assert.equal(await field(app).getAttribute("type"), "password");
      assert.equal(await field(app).getAttribute("value"), null);
      assert.equal(await field(app).inputValue(), "");
      assert.equal(await app.page.locator("form input[name=username], form input[autocomplete=username]").count(), 0, "token sign-in has no user name field");
    });
  });

  test("after each kind of failure the field is empty, masked again and focused", async () => {
    for (const [status, headers] of [[401, {}], [429, { "retry-after": "5" }], [500, {}]] as const) {
      await withApp({}, async (app) => {
        answerLogin(app, status, headers);
        await field(app).waitFor();
        await app.page.getByRole("button", { name: "Show token" }).click();
        assert.equal(await field(app).getAttribute("type"), "text");
        await submit(app, CANARY);
        await app.page.getByRole("alert").filter({ hasText: /\w/ }).waitFor();
        assert.equal(await field(app).inputValue(), "", `status ${status}`);
        assert.equal(await field(app).getAttribute("type"), "password", `status ${status}: revealed state does not carry over`);
        assert.equal(await app.page.evaluate(() => document.activeElement?.id), "login-token");
        assert.ok(!(await app.page.content()).includes(CANARY));
        assert.ok(await app.page.evaluate((c) => !JSON.stringify([{ ...localStorage }, { ...sessionStorage }]).includes(c) && !location.href.includes(c), CANARY));
      });
    }
  });

  test("a network failure clears the field as well", async () => {
    await withApp({}, async (app) => {
      await field(app).waitFor();
      await app.page.route("**/api/v1/session", (route) => route.request().method() === "POST" ? route.abort() : route.continue());
      await submit(app, CANARY);
      await app.page.getByRole("alert").filter({ hasText: "cannot be reached" }).waitFor();
      assert.equal(await field(app).inputValue(), "");
    });
  });
});

describe("sign-in: CSP and logging", opts, () => {
  test("no inline style attribute, no inline script, no CSP violation", async () => {
    await withApp({}, async (app) => {
      await field(app).waitFor();
      const inline = await app.page.evaluate(() => ({
        styled: Array.from(document.querySelectorAll("[style]")).map((e) => e.tagName),
        scripts: Array.from(document.querySelectorAll("script")).filter((s) => !s.src).length,
        handlers: Array.from(document.querySelectorAll("*")).flatMap((e) => e.getAttributeNames().filter((a) => /^on/i.test(a))),
        styleTags: document.querySelectorAll("style").length,
      }));
      assert.deepEqual(inline.styled, []);
      assert.equal(inline.scripts, 0);
      assert.deepEqual(inline.handlers, []);
      assert.equal(inline.styleTags, 0);
      await submit(app, WRONG_TOKEN);
      await app.page.getByRole("alert").filter({ hasText: "not correct" }).waitFor();
      assert.equal(await app.page.evaluate(() => document.querySelectorAll("[style]").length), 0, "the error state adds no inline style either");
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });

  test("what is typed reaches no console line, no URL and no request but the one login body", async () => {
    await withApp({}, async (app) => {
      const lines: string[] = [];
      app.page.on("console", (m) => { lines.push(m.text()); });
      app.page.on("pageerror", (e) => { lines.push(String(e)); });
      await field(app).waitFor();
      await submit(app, CANARY);
      await app.page.getByRole("alert").filter({ hasText: "not correct" }).waitFor();
      assert.ok(lines.every((l) => !l.includes(CANARY)), lines.join("\n"));
      const withCanary = app.server.requests.filter((r) => r.body.includes(CANARY) || r.url.includes(CANARY));
      assert.equal(withCanary.length, 1);
      assert.equal(withCanary[0]!.method + " " + withCanary[0]!.url, "POST /api/v1/session");
      assert.ok(!app.page.url().includes(CANARY));
    });
  });

  test("axe clean with an error showing", async () => {
    await withApp({}, async (app) => {
      await field(app).waitFor();
      await submit(app, WRONG_TOKEN);
      await app.page.getByRole("alert").filter({ hasText: "not correct" }).waitFor();
      await expectAxeClean(app.page, "login error");
    });
  });
});
