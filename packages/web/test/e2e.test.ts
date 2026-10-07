import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, setup, signIn, teardown, TOKEN, WRONG_TOKEN, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const GROUPS = ["Workspace", "Build", "Control"];

describe("sign-in", opts, () => {
  test("an anonymous visit is redirected to the sign-in page with the token field focused", opts, async () => {
    await withApp({}, async ({ page }) => {
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      assert.match(page.url(), /#\/login$/);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "login-token");
    });
  });

  test("wrong token: alert, stays on sign-in, field cleared and focused; no token in any URL or log line", async () => {
    await withApp({}, async ({ page, server, problems }) => {
      await signIn(page, WRONG_TOKEN);
      await page.getByRole("alert").filter({ hasText: "token is not correct" }).waitFor();
      assert.match(page.url(), /#\/login$/);
      assert.equal(await page.getByLabel("Owner token", { exact: true }).inputValue(), "");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "login-token");
      assert.equal(await page.getByLabel("Owner token", { exact: true }).getAttribute("aria-invalid"), "true");
      assert.ok(server.requests.every((q) => !q.url.includes(WRONG_TOKEN)));
      assert.deepEqual(problems, []);
    });
  });

  test("empty submit shows the required message and focuses the token field", async () => {
    await withApp({}, async ({ page }) => {
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("alert").filter({ hasText: "Enter the owner token" }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.id), "login-token");
    });
  });

  test("success lands on Chat; the session cookie is HttpOnly; a reload keeps the session", async () => {
    await withApp({}, async ({ page, context, problems }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      assert.match(page.url(), /#\/chat$/);
      await page.getByText("Signed in as owner").waitFor();
      assert.ok(!(await page.evaluate(() => document.cookie)).includes("plur1bus_session"));
      const cookie = (await context.cookies()).find((c) => c.name === "plur1bus_session");
      assert.equal(cookie?.httpOnly, true);
      assert.equal(cookie?.sameSite, "Strict");
      await page.reload();
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      assert.deepEqual(problems, []);
    });
  });

  test("a deep link while signed out returns there after sign-in", async () => {
    await withApp({ hash: "#/agents" }, async ({ page }) => {
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      await signIn(page);
      await page.getByRole("heading", { name: "Agents", level: 1 }).waitFor();
      assert.match(page.url(), /#\/agents$/);
    });
  });

  test("too many attempts shows the retry hint", async () => {
    await withApp({ server: { maxFailures: 2, retryAfterSeconds: 42 } }, async ({ page }) => {
      for (let i = 0; i < 2; i++) { await signIn(page, WRONG_TOKEN); await page.getByRole("alert").filter({ hasText: "token is not correct" }).waitFor(); }
      await signIn(page);
      await page.getByRole("alert").filter({ hasText: "Too many attempts. Try again in 42 s." }).waitFor();
    });
  });

  test("an unreachable harness shows the network message", async () => {
    await withApp({}, async ({ page, context }) => {
      await context.route("**/api/v1/session", (r) => r.abort());
      await signIn(page);
      await page.getByRole("alert").filter({ hasText: "cannot be reached" }).waitFor();
    });
  });

  test("token reveal toggles the field type", async () => {
    await withApp({}, async ({ page }) => {
      const field = page.getByLabel("Owner token", { exact: true });
      assert.equal(await field.getAttribute("type"), "password");
      await page.getByRole("button", { name: "Show token" }).click();
      assert.equal(await field.getAttribute("type"), "text");
      await page.getByRole("button", { name: "Hide token" }).click();
      assert.equal(await field.getAttribute("type"), "password");
    });
  });

  test("sign out ends the server session (with the CSRF token) and returns to sign-in", async () => {
    await withApp({}, async ({ page, server }) => {
      await signIn(page);
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      assert.equal(server.sessions.size, 0);
      const post = server.requests.filter((q) => q.method === "DELETE" && q.url === "/api/v1/session").at(-1);
      assert.ok(post?.csrf);
      await page.goto(page.url().split("#")[0] + "#/chat");
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
    });
  });

  test("the token reaches the server only in the login body: not in a URL, storage, the DOM after sign-in or any console line", async () => {
    await withApp({}, async ({ page, server }) => {
      const lines: string[] = [];
      page.on("console", (m) => lines.push(m.text()));
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      for (const q of server.requests) {
        assert.ok(!q.url.includes(TOKEN), q.url);
        if (!(q.method === "POST" && q.url === "/api/v1/session")) assert.ok(!q.body.includes(TOKEN));
      }
      const leaked = await page.evaluate((t) => JSON.stringify([localStorage, sessionStorage]).includes(t) || document.documentElement.outerHTML.includes(t) || location.href.includes(t), TOKEN);
      assert.equal(leaked, false);
      assert.ok(lines.every((l) => !l.includes(TOKEN)));
    });
  });

  test("a signed-in user opening #/login is sent to Chat", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await page.evaluate(() => { location.hash = "#/login"; });
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
    });
  });
});

describe("shell", opts, () => {
  test("sidebar groups, items, pinned Settings and Help follow the canvas", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      const nav = page.getByRole("navigation", { name: "Main navigation" });
      await nav.waitFor();
      const labels = await nav.locator(".group-label").allTextContents();
      assert.deepEqual(labels.map((s) => s.trim()), GROUPS);
      const groupItems = async (name: string): Promise<string[]> => (await nav.getByRole("list", { name }).getByRole("link").allTextContents()).map((s) => s.trim());
      assert.deepEqual(await groupItems("Workspace"), ["Chat", "Projects", "Agents", "Inbox", "Memories & Dreams"]);
      assert.deepEqual(await groupItems("Build"), ["Library", "Skills", "Plugins", "Models", "Switchboard", "Recurring Tasks"]);
      assert.deepEqual(await groupItems("Control"), ["Approvals", "Usage & Quota", "Doctor", "Logs"]);
      assert.deepEqual((await nav.locator(".nav-bottom a").allTextContents()).map((s) => s.trim()), ["Settings", "Help"]);
      assert.equal(await page.getByRole("button", { name: "Search everything" }).isDisabled(), false); // opens the command palette (test/palette-e2e.test.ts)
    });
  });

  test("each route renders its page, marks the active item, moves focus to the heading and sets the title", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      for (const name of ["Projects", "Skills", "Logs", "Settings", "Help"]) {
        await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
        await page.getByRole("heading", { name, level: 1 }).waitFor();
        assert.equal(await page.getByRole("navigation").locator("[aria-current=page]").innerText().then((s) => s.trim()), name);
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");
        assert.equal(await page.title(), `${name} · PLUR1BUS`);
      }
    });
  });

  test("an unknown route shows Page not found with a way back", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor(); // the sign-in must land before the hash is changed
      await page.evaluate(() => { location.hash = "#/does-not-exist"; });
      await page.getByRole("heading", { name: "Page not found", level: 1 }).waitFor();
      await page.getByRole("link", { name: "Back to Chat" }).click();
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
    });
  });

  test("the skip button moves focus to the page heading", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Skip to content");
      await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");
    });
  });
});

describe("theme", opts, () => {
  const bg = (page: import("playwright").Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // "No OS preference falls back to dark" is asserted on the CSS structure in build.test.ts: Chromium evaluates an
  // emulated colour scheme of "no-preference" as light, so it cannot be driven from here.
  test("follows the OS: light for light, dark for dark", async () => {
    for (const [scheme, expected] of [["light", "rgb(245, 244, 241)"], ["dark", "rgb(11, 11, 14)"]] as const) {
      await withApp({ colorScheme: scheme }, async ({ page }) => {
        await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
        assert.equal(await bg(page), expected, scheme);
      });
    }
  });

  test("the override wins over the OS, is applied to <html>, and survives a reload", async () => {
    await withApp({ colorScheme: "light" }, async ({ page }) => {
      await page.getByLabel("Theme").selectOption("dark");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
      assert.equal(await bg(page), "rgb(11, 11, 14)");
      await page.reload();
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      assert.equal(await page.getByLabel("Theme").inputValue(), "dark");
      assert.equal(await bg(page), "rgb(11, 11, 14)");
      await page.getByLabel("Theme").selectOption("system");
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-theme")), false);
      assert.equal(await bg(page), "rgb(245, 244, 241)");
    });
  });
});

describe("language", opts, () => {
  test("follows the browser language (de) and the picker switches text and <html lang>", async () => {
    await withApp({ locale: "de-DE" }, async ({ page }) => {
      await page.getByRole("heading", { name: "Anmelden", level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.lang), "de");
      await page.getByLabel("Sprache").selectOption("en");
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
      await page.reload();
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
    });
  });

  test("the shell is translated: German navigation and labels", async () => {
    await withApp({ locale: "de-DE" }, async ({ page }) => {
      await signIn(page, TOKEN, "de");
      await page.getByRole("navigation", { name: "Hauptnavigation" }).waitFor();
      const labels = await page.locator(".group-label").allTextContents();
      assert.deepEqual(labels.map((s) => s.trim()), ["Arbeitsbereich", "Aufbau", "Kontrolle"]);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await page.getByRole("button", { name: "Abmelden" }).waitFor();
    });
  });
});

describe("strict CSP", opts, () => {
  test("the page is served with the strict header and runs with no violation or console error", async () => {
    await withApp({}, async ({ page, baseUrl, problems }) => {
      const res = await page.request.get(baseUrl + "/");
      const csp = res.headers()["content-security-policy"] ?? "";
      assert.match(csp, /script-src 'self';/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
      await page.evaluate(() => { (window as unknown as { __v: string[] }).__v = []; document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __v: string[] }).__v.push(e.violatedDirective)); });
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await page.getByLabel("Theme").selectOption("light");
      assert.deepEqual(await page.evaluate(() => (window as unknown as { __v: string[] }).__v), []);
      assert.deepEqual(problems, []);
    });
  });
});
