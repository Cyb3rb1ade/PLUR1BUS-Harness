// The command palette in a real browser: hotkey, keyboard operation, focus, sensitive values, responsive targets and axe.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, setup, signIn, teardown, withApp, type App } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const CONFIG = {
  metrics: { enabled: true, port: 9464 },
  core: { logLevel: "debug", recall: { softBudgetMs: 1234 } },
  secrets: { fileFallback: { enabled: true } },
  providers: { openai: { apiKey: "sk-TOPSECRET-123" } },
  egress: { allowHosts: ["api.example.org"] },
};

async function shell(app: App, withConfig = true): Promise<Page> {
  if (withConfig) app.server.rpc.handle("config.get", () => ({ key: null, tier: null, value: CONFIG, restartClass: null, restart: null, revision: "r1" }), { write: false });
  await signIn(app.page);
  await app.page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
  return app.page;
}
// The header selects are comboboxes too; the palette's field is the one inside the dialog.
const dlg = (page: Page) => page.locator("dialog.palette");
const combo = (page: Page) => page.locator("dialog.palette [role=combobox]");
/** The platform's shortcut modifier as the app decides it (⌘ on macOS, Ctrl elsewhere); the suite runs on both. */
const mods = (page: Page) => page.evaluate(() => (/mac|iphone|ipad/i.test(navigator.platform) ? { mod: "Meta", other: "Control" } : { mod: "Control", other: "Meta" }));
async function open(page: Page): Promise<void> {
  await page.keyboard.press(`${(await mods(page)).mod}+K`);
  await combo(page).waitFor();
}
const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");
const hash = (page: Page) => page.evaluate(() => location.hash);

describe("palette: opening and closing", opts, () => {
  test("the platform shortcut (Cmd+K on macOS, Ctrl+K elsewhere) opens a modal dialog with the search field focused; the shortcut again and Esc close it", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await open(page);
      assert.equal(await page.locator("dialog.palette[open]").count(), 1);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox");
      await page.keyboard.press(`${(await mods(page)).mod}+K`);
      await page.locator("dialog.palette").waitFor({ state: "detached" });
      await open(page);
      await page.keyboard.press("Escape");
      await page.locator("dialog.palette").waitFor({ state: "detached" });
      assert.deepEqual(app.problems, []);
    });
  });

  test("the other platform's modifier does nothing, and a signed-out page has no palette", async () => {
    await withApp({}, async (app) => {
      await app.page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      const { mod, other } = await mods(app.page);
      await app.page.keyboard.press(`${mod}+K`);
      await app.page.keyboard.press("/");
      assert.equal(await app.page.locator("dialog.palette").count(), 0);
      await shell(app);
      await app.page.keyboard.press(`${other}+K`);
      assert.equal(await app.page.locator("dialog.palette").count(), 0);
    });
  });

  test("/ opens it, except while typing in a field; the search pill opens it and is enabled", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await page.keyboard.press("/");
      await combo(page).waitFor();
      await page.keyboard.press("Escape");
      await page.locator("dialog.palette").waitFor({ state: "detached" });
      const pill = page.locator(".search-pill");
      assert.equal(await pill.isDisabled(), false);
      await pill.click();
      await combo(page).waitFor();
      await page.keyboard.type("a/b"); // a slash typed into the field stays text
      assert.equal(await combo(page).inputValue(), "a/b");
    });
  });

  test("Esc returns focus to the element that had it; so does the close button", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await page.getByRole("link", { name: "Agents" }).focus();
      await open(page);
      await page.keyboard.press("Escape");
      await page.locator("dialog.palette").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Agents");
      await page.locator(".search-pill").focus();
      await page.keyboard.press("Enter");
      await combo(page).waitFor();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.locator("dialog.palette").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.className.includes("search-pill")), true);
    });
  });

  test("focus stays inside while tabbing, forwards and backwards", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await open(page);
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest("dialog.palette")), true, `tab ${i}`);
      }
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest("dialog.palette")), true, `shift-tab ${i}`);
      }
    });
  });
});

describe("palette: keyboard operation", opts, () => {
  test("combobox and listbox semantics; arrows move aria-activedescendant and wrap; the count is announced politely", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await open(page);
      const c = combo(page);
      assert.equal(await c.getAttribute("aria-expanded"), "true");
      assert.equal(await c.getAttribute("aria-autocomplete"), "list");
      const list = dlg(page).getByRole("listbox");
      assert.equal(await c.getAttribute("aria-controls"), await list.getAttribute("id"));
      const options = dlg(page).getByRole("option");
      const n = await options.count();
      assert.ok(n >= 17);
      const first = await c.getAttribute("aria-activedescendant");
      assert.equal(await options.first().getAttribute("id"), first);
      assert.equal(await options.first().getAttribute("aria-selected"), "true");
      await page.keyboard.press("ArrowDown");
      assert.equal(await options.nth(1).getAttribute("aria-selected"), "true");
      assert.equal(await c.getAttribute("aria-activedescendant"), await options.nth(1).getAttribute("id"));
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp"); // wraps to the last
      assert.equal(await options.nth(n - 1).getAttribute("aria-selected"), "true");
      await page.keyboard.press("ArrowDown");
      assert.equal(await options.first().getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("dialog.palette [role=status]").getAttribute("aria-live"), "polite");
      await c.fill("log");
      // The count is announced when the list has settled (rate limited), so wait for it.
      await page.waitForFunction(() => /^\d+ results$/.test(document.querySelector("dialog.palette [role=status]")?.textContent ?? "") && document.querySelector("dialog.palette [role=status]")?.textContent !== "30 results");
      assert.equal((await page.locator("dialog.palette [role=status]").textContent()) ?? "", `${await options.count()} results`);
      await c.fill("zzzzzz"); // an Owner still gets the "Search logs for ..." fallback, nothing else
      await options.first().waitFor();
      assert.equal(await options.count(), 1);
      assert.equal(await options.first().textContent(), "Search logs for “zzzzzz”");
    });
  });

  test("a role without log access gets 'No results' (no listbox, aria-expanded false)", async () => {
    await withApp({ server: { role: "member" } }, async (app) => {
      const page = await shell(app);
      await open(page);
      const c = combo(page);
      await c.fill("zzzzzz");
      assert.equal(await c.getAttribute("aria-expanded"), "false");
      assert.equal(await c.getAttribute("aria-controls"), null);
      await page.waitForFunction(() => document.querySelector("dialog.palette [role=status]")?.textContent === "No results");
      await page.getByText("No results", { exact: true }).first().waitFor();
    });
  });

  test("groups: Navigation then Settings; Enter on a page hit navigates and moves focus to the new page heading", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await open(page);
      await combo(page).fill("dreams");
      const groups = await page.locator("dialog.palette [role=group]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? document.getElementById(e.getAttribute("aria-labelledby") ?? "")?.textContent));
      assert.deepEqual(groups, ["Navigation", "Logs"]); // Logs: the Owner's "Search logs for ..." fallback, always last
      assert.equal((await dlg(page).getByRole("option").first().textContent())?.startsWith("Dreams"), true);
      await page.keyboard.press("Enter");
      await page.locator("dialog.palette").waitFor({ state: "detached" });
      assert.equal(await hash(page), "#/memories/dreams");
      await page.waitForFunction(() => document.activeElement?.tagName === "H1");
      assert.deepEqual(app.problems, []);
    });
  });

  test("a settings hit opens #/settings/<section>?focus=<key>; typing finds it by label, key, help and value", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await open(page);
      await combo(page).fill("soft budget");
      await dlg(page).getByRole("option", { name: /Soft budget ms/ }).waitFor();
      await page.keyboard.press("Enter");
      await page.locator("dialog.palette").waitFor({ state: "detached" });
      assert.equal(await hash(page), "#/settings/general?focus=core.recall.softBudgetMs");
      await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === "H1");
      // Same page again: the query changes, focus must not be lost to <body>.
      await open(page);
      await combo(page).fill("loopback");
      await dlg(page).getByRole("option", { name: /Allow loopback/ }).waitFor();
      await page.keyboard.press("Enter");
      await page.locator("dialog.palette").waitFor({ state: "detached" });
      assert.equal(await hash(page), "#/settings/network?focus=egress.allowLoopback");
      await page.waitForFunction(() => document.activeElement?.tagName === "H1");
      await open(page);
      await combo(page).fill("9464"); // current value, from config.get
      await dlg(page).getByRole("option", { name: /Port/ }).waitFor();
      await dlg(page).getByRole("option", { name: /Port/ }).click();
      assert.equal(await hash(page), "#/settings/general?focus=metrics.port");
    });
  });

  test("matches are marked with <mark> text nodes; hostile input creates no elements", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await open(page);
      await combo(page).fill("log");
      await page.locator("dialog.palette mark").first().waitFor();
      assert.equal((await page.locator("dialog.palette mark").first().textContent())?.toLowerCase(), "log");
      await combo(page).fill("<img src=x onerror=alert(1)>");
      assert.equal(await page.locator("dialog.palette img").count(), 0);
      assert.deepEqual(app.problems, []);
    });
  });

  test("German: umlaut-free query finds the German label; the UI is German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      app.server.rpc.handle("config.get", () => ({ key: null, tier: null, value: CONFIG, restartClass: null, restart: null, revision: "r1" }), { write: false });
      await signIn(app.page, undefined, "de");
      await app.page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await app.page.keyboard.press(`${(await mods(app.page)).mod}+K`);
      const c = combo(app.page);
      await c.waitFor();
      assert.equal(await c.getAttribute("aria-label"), "Seiten, Aktionen, Agenten, Chats und Einstellungen durchsuchen");
      await c.fill("traume");
      assert.equal((await dlg(app.page).getByRole("option").first().textContent())?.startsWith("Träume"), true);
      await c.fill("memories"); // the English label is found from the German UI too
      await dlg(app.page).getByRole("option", { name: /Erinnerungen/ }).first().waitFor();
    });
  });
});

describe("palette: values and sensitive keys", opts, () => {
  test("values appear for plain keys and never for sensitive ones, in the DOM or in what can be searched", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await open(page);
      await combo(page).fill("port");
      await page.getByText("= 9464").waitFor();
      await combo(page).fill("true"); // secrets.fileFallback.enabled is true, but its key names a secret
      await dlg(page).getByRole("option", { name: /Enabled/ }).first().waitFor(); // metrics.enabled
      const keys = await page.locator("dialog.palette [role=option]").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
      assert.ok(keys.some((k) => k.includes("metrics.enabled")));
      assert.ok(!keys.some((k) => k.includes("secrets.fileFallback.enabled")), "a sensitive key's value must not be searchable");
      await combo(page).fill("secrets");
      const secretRow = (await page.locator("dialog.palette [role=option]", { hasText: "secrets.fileFallback.enabled" }).first().textContent()) ?? "";
      assert.ok(secretRow.includes("secrets.fileFallback.enabled") && !secretRow.includes("= true"), secretRow);
      await combo(page).fill("TOPSECRET");
      await dlg(page).getByRole("option").first().waitFor();
      assert.deepEqual(await dlg(page).getByRole("option").allTextContents(), ["Search logs for “TOPSECRET”"]); // only the query-built fallback, no setting
      assert.equal((await page.content()).includes("sk-TOPSECRET-123"), false);
    });
  });

  test("without a reachable config.get the palette still works and shows no error", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app, false); // /rpc answers 404 in the mock
      await open(page);
      await combo(page).fill("log level");
      await dlg(page).getByRole("option", { name: /Log level/ }).waitFor();
      assert.equal(await page.locator("dialog.palette [role=alert]").count(), 0);
      assert.equal(await page.locator("dialog.palette").getByText(/= /).count(), 0);
      assert.deepEqual(app.problems, []);
    });
  });
});

const WIDTHS = [400, 960, 1440, 2560] as const;
describe("palette: responsive", opts, () => {
  for (const width of WIDTHS) {
    test(`${width} px: dialog <= 680 px (full screen on a phone-sized window), no scroll, text >= 12 px, targets >= ${width < 1024 ? 44 : 24} px`, async () => {
      await withApp({ width, height: 800 }, async (app) => {
        const page = await shell(app);
        await open(page);
        await combo(page).fill("e");
        await dlg(page).getByRole("option").first().waitFor();
        const m = await page.evaluate(() => {
          const d = document.querySelector("dialog.palette")!.getBoundingClientRect();
          const small = (el: Element): number => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height); };
          const targets = Array.from(document.querySelectorAll("dialog.palette [role=option], dialog.palette button, dialog.palette input")).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2;
          }).map(small);
          let minFont = Infinity;
          const w = document.createTreeWalker(document.querySelector("dialog.palette")!, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            const el = n.parentElement!;
            if ((n.textContent ?? "").trim() && !el.closest(".sr-only") && el.getBoundingClientRect().width > 2) minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize));
          }
          const list = document.querySelector<HTMLElement>("dialog.palette [role=listbox]")!;
          return {
            w: Math.round(d.width), h: Math.round(d.height), left: Math.round(d.left), top: Math.round(d.top), vw: innerWidth, vh: innerHeight,
            pageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, listScroll: list.scrollWidth > list.clientWidth,
            minTarget: Math.floor(Math.min(...targets)), minFont,
          };
        });
        assert.ok(m.w <= 680, `dialog ${m.w}px`);
        if (width < 720) { assert.equal(m.w, m.vw); assert.equal(m.h, m.vh); assert.equal(m.left, 0); assert.equal(m.top, 0); }
        else assert.ok(m.h < m.vh);
        assert.equal(m.pageScroll, false);
        assert.equal(m.listScroll, false);
        assert.ok(m.minFont >= 12, `text ${m.minFont}px`);
        assert.ok(m.minTarget >= (width < 1024 ? 44 : 24), `target ${m.minTarget}px`);
      });
    });
  }

  test("a long result list scrolls inside the dialog and keeps the active option visible", async () => {
    await withApp({ width: 1440, height: 500 }, async (app) => {
      const page = await shell(app);
      await open(page);
      for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowDown");
      const inView = await page.evaluate(() => {
        const o = document.querySelector("dialog.palette [role=option][aria-selected=true]")!.getBoundingClientRect();
        const l = document.querySelector("dialog.palette [role=listbox]")!.getBoundingClientRect();
        return o.top >= l.top - 1 && o.bottom <= l.bottom + 1;
      });
      assert.equal(inView, true);
    });
  });
});

describe("palette: axe (WCAG 2.1 AA)", opts, () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 1440], ["light", 400], ["dark", 400]] as const) {
    test(`${scheme}, ${width} px: open, with hits, with only the fallback`, async () => {
      await withApp({ colorScheme: scheme, width, height: 800 }, async (app) => {
        const page = await shell(app);
        await open(page);
        await expectAxeClean(page, "open, empty query");
        await combo(page).fill("log");
        await page.locator("dialog.palette mark").first().waitFor();
        await page.keyboard.press("ArrowDown");
        await expectAxeClean(page, "with hits");
        await combo(page).fill("zzzzzz");
        await page.getByRole("option", { name: /Search logs for/ }).waitFor();
        await expectAxeClean(page, "only the log search fallback");
      });
    });
  }

  test("German, with value rows", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      app.server.rpc.handle("config.get", () => ({ key: null, tier: null, value: CONFIG, restartClass: null, restart: null, revision: "r1" }), { write: false });
      await signIn(app.page, undefined, "de");
      await app.page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await app.page.keyboard.press(`${(await mods(app.page)).mod}+K`);
      await combo(app.page).fill("port");
      await app.page.getByText("= 9464").waitFor();
      await expectAxeClean(app.page, "de");
    });
  });
});
