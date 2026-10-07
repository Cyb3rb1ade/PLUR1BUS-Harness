// Doctor / status page (E9): states, degraded vs down, partial unavailability, provisioning results and export,
// auto-refresh, layout and accessibility. Everything runs against the mock server (test/doctor-fixtures.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { AGENTS, CHECK_DOC, CHECK_RAW, CORE_DEGRADED, CORE_OK, DoctorMock, HEALTH_DEGRADED, HEALTH_DOWN, HEALTH_OK, until } from "./doctor-fixtures.ts";
import { browserSkip, setup, signIn, teardown, withApp, type App, type AppOptions } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

/** Opens #/doctor (a deep link survives sign-in) with the mock prepared by `prep`. */
async function doctor(o: AppOptions, prep: (m: DoctorMock, app: App) => void | Promise<void>, run: (app: App, m: DoctorMock) => Promise<void>, mockOpts: ConstructorParameters<typeof DoctorMock>[1] = {}): Promise<void> {
  await withApp({ hash: "#/doctor", ...o }, async (app) => {
    const m = new DoctorMock(app.server, mockOpts);
    await prep(m, app);
    await signIn(app.page, undefined, o.locale?.startsWith("de") ? "de" : "en");
    await app.page.getByRole("heading", { name: o.locale?.startsWith("de") ? "Status" : "Doctor", level: 1 }).waitFor();
    await run(app, m);
    assert.deepEqual(app.problems, []);
  });
}
const banner = (page: Page, kind: string) => page.locator(`[data-banner="${kind}"]`);
const recheck = (page: Page) => page.getByRole("button", { name: /^(Re-check|Erneut prüfen)$/ });

describe("health states", opts, () => {
  test("ok: banner, versions, readable uptime, engine ready, agents; axe clean (light and dark)", async () => {
    for (const scheme of ["light", "dark"] as const) {
      await doctor({ colorScheme: scheme }, () => {}, async ({ page }) => {
        const b = banner(page, "ok");
        await b.waitFor();
        assert.equal(await b.getAttribute("role"), "status");
        assert.match(await b.innerText(), /All systems normal/);
        const card = page.getByRole("group", { name: "API and core" });
        const text = await card.innerText();
        for (const want of ["1.4.0", "1.3.0", "2.0.0", "1 day, 3 hr"]) assert.ok(text.includes(want), `${want} in ${text}`);
        assert.match(text, /Engine ready\s*Yes/);
        const agents = page.getByRole("group", { name: "Agents" });
        await agents.getByText("scribe").waitFor();
        assert.match(await agents.innerText(), /Dreaming/);
        assert.match(await agents.innerText(), /REM/);
        await expectAxeClean(page, `ok ${scheme}`);
      });
    }
  });

  test("degraded: banner with icon, text and the cause from core.status; role status; axe clean", async () => {
    await doctor({}, (m) => { m.health = { status: 200, body: HEALTH_DEGRADED }; }, async ({ page }) => {
      const b = banner(page, "degraded");
      await b.waitFor();
      assert.equal(await b.getAttribute("role"), "status");
      const text = await b.innerText();
      assert.match(text, /Degraded mode/);
      assert.match(text, /Cause: embedder-failed \(capability: semantic-recall\)/);
      assert.match(text, /model file missing/);
      assert.equal(await b.locator("svg[aria-hidden=true]").count(), 1, "an icon, so colour is not the only signal");
      assert.equal(await banner(page, "ok").count(), 0);
      await expectAxeClean(page, "degraded");
    }, { core: CORE_DEGRADED });
  });

  test("degraded without core.status: the cause falls back to what health says; the rest of the page works", async () => {
    await doctor({}, (m) => { m.health = { status: 200, body: { ...HEALTH_DEGRADED, core: { ...HEALTH_DEGRADED.core, engineReady: false } } }; }, async ({ page }) => {
      const b = banner(page, "degraded");
      await b.waitFor();
      assert.match(await b.innerText(), /the engine is not ready yet/);
      await page.getByRole("group", { name: "Core details" }).getByText("Not available").waitFor();
      await page.getByRole("group", { name: "API and core" }).getByText("1.4.0").waitFor();
    }, { core: "off" });
  });

  test("down (503) is not degraded: alert, own text, only the API version from the 503 body; Re-check recovers", async () => {
    await doctor({}, (m) => { m.health = { status: 503, body: HEALTH_DOWN }; m.agents = { status: 503, body: {} }; }, async ({ page }, m) => {
      const b = banner(page, "down");
      await b.waitFor();
      assert.equal(await b.getByRole("alert").count(), 1);
      assert.match(await b.innerText(), /The core is not reachable/);
      assert.equal(await banner(page, "degraded").count(), 0);
      const facts = page.getByRole("group", { name: "API and core" });
      await facts.getByText("1.4.0").waitFor();
      assert.equal(await facts.getByText("Core RPC version").count(), 0);
      await expectAxeClean(page, "down");
      m.health = { status: 200, body: HEALTH_OK }; m.agents = { status: 200, body: AGENTS };
      await recheck(page).click();
      await banner(page, "ok").waitFor();
      assert.equal(await banner(page, "down").count(), 0);
    }, { core: CORE_OK });
  });

  test("health route missing (404): status unknown, parts still load", async () => {
    await doctor({}, (m) => { m.health = { status: 404, body: { schema: "error/1", error: "E_NOT_FOUND" } }; }, async ({ page }) => {
      const b = banner(page, "unknown");
      await b.waitFor();
      assert.match(await b.innerText(), /Status unknown/);
      await page.getByRole("group", { name: "Agents" }).getByText("main", { exact: true }).waitFor();
      await expectAxeClean(page, "unknown");
    });
  });

  test("forbidden (403) on health: the page shows the forbidden state", async () => {
    await doctor({}, (m) => { m.health = { status: 403, body: { schema: "error/1", error: "E_DENIED", reason: "no-permission" } }; }, async ({ page }) => {
      await page.getByRole("heading", { name: "Not allowed", level: 2 }).waitFor();
      await expectAxeClean(page, "forbidden");
    });
  });

  test("agents and core.status unavailable: only those parts say so, the health card stays", async () => {
    await doctor({}, (m) => { m.agents = { status: 404, body: {} }; }, async ({ page }) => {
      await banner(page, "ok").waitFor();
      for (const name of ["Agents", "Core details"]) await page.getByRole("group", { name }).getByText("Not available").waitFor();
      await page.getByRole("group", { name: "API and core" }).getByText("1.4.0").waitFor();
      await expectAxeClean(page, "parts unavailable");
    }, { core: "off" });
  });

  test("empty agent list", async () => {
    await doctor({}, (m) => { m.agents = { status: 200, body: { schema: "agents.list/1", agents: [] } }; }, async ({ page }) => {
      await page.getByRole("group", { name: "Agents" }).getByText("No agents are configured.").waitFor();
      await expectAxeClean(page, "empty agents");
    });
  });

  test("an expired session sends the page to sign-in and back to /doctor afterwards", async () => {
    await doctor({}, () => {}, async ({ page, server }) => {
      await banner(page, "ok").waitFor();
      server.expireAll();
      await recheck(page).click();
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      await signIn(page);
      await page.getByRole("heading", { name: "Doctor", level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => location.hash), "#/doctor");
    });
  });

  test("German texts and Intl formatting", async () => {
    await doctor({ locale: "de-DE" }, (m) => { m.health = { status: 200, body: HEALTH_DEGRADED }; }, async ({ page }) => {
      const b = banner(page, "degraded");
      await b.waitFor();
      assert.match(await b.innerText(), /Eingeschränkter Betrieb/);
      assert.match(await page.getByRole("group", { name: "API und Core" }).innerText(), /1 Tg\., 3 Std\./);
      await recheck(page).waitFor();
      await expectAxeClean(page, "de");
    }, { core: CORE_DEGRADED });
  });
});

describe("provisioning results", opts, () => {
  const load = async (page: Page, text: string, name = "check.json"): Promise<void> => {
    await page.getByLabel("Load a 1staid check result (JSON file)").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(text) });
  };

  test("no live source: says so, offers the file loader; nothing is shown before a file is loaded", async () => {
    await doctor({}, () => {}, async ({ page }) => {
      const card = page.getByRole("group", { name: "Provisioning results" });
      assert.match(await card.innerText(), /No live source/);
      assert.equal(await card.getByRole("button", { name: "Download JSON" }).count(), 0);
      await expectAxeClean(page, "provisioning empty");
    });
  });

  test("a loaded 1staid.check/1 file is shown as a table; detail values are not shown; axe clean", async () => {
    await doctor({ width: 1440 }, () => {}, async ({ page }) => {
      await load(page, CHECK_RAW);
      const table = page.getByRole("table", { name: "1staid check results" });
      await table.waitFor();
      assert.equal(await table.getByRole("row").count(), CHECK_DOC.checks.length + 1);
      assert.deepEqual(await table.getByRole("columnheader").allTextContents(), ["Check", "Status", "Message", "How to fix"]);
      const row = table.getByRole("row", { name: /run\.permissions/ });
      const cells = await row.getByRole("cell").allInnerTexts();
      assert.deepEqual(cells, ["run.permissions", "Failed", "run/ is 777, expected 0700", "Run: plur1bus 1staid repair --yes"]);
      assert.match(await table.getByRole("row", { name: /windows\.pipe-acl/ }).innerText(), /Skipped/);
      assert.match(await page.getByRole("group", { name: "Provisioning results" }).innerText(), /at least one check failed/);
      assert.ok(!(await page.locator("main").innerText()).includes("/Users/someone"), "detail stays out of the page");
      await expectAxeClean(page, "provisioning table");
    });
  });

  test("refuses files that are not 1staid.check/1 and says why (alert)", async () => {
    await doctor({}, () => {}, async ({ page }) => {
      await load(page, "{nope");
      await page.getByRole("alert").filter({ hasText: "not valid JSON" }).waitFor();
      await load(page, JSON.stringify({ schema: "other/1" }));
      await page.getByRole("alert").filter({ hasText: "not a 1staid.check/1 document" }).waitFor();
      await load(page, JSON.stringify({ schema: "1staid.check/1", ok: true, checks: [{ id: "x", status: "great", summary: "" }] }));
      await page.getByRole("alert").filter({ hasText: "does not match" }).waitFor();
      assert.equal(await page.getByRole("table", { name: "1staid check results" }).count(), 0);
      await expectAxeClean(page, "provisioning error");
    });
  });

  test("Download JSON gives back the unchanged raw text and sends nothing over the network", async () => {
    await doctor({}, () => {}, async ({ page, server }) => {
      await banner(page, "ok").waitFor();
      await load(page, CHECK_RAW);
      await page.getByRole("table", { name: "1staid check results" }).waitFor();
      const before = server.requests.length;
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download JSON" }).click()]);
      assert.equal(dl.suggestedFilename(), "1staid-check.json");
      const path = await dl.path();
      assert.equal(await readFile(path, "utf8"), CHECK_RAW);
      assert.equal(server.requests.length, before, "no request was made");
    });
  });

  test("Copy as JSON puts the unchanged raw text on the clipboard and announces it", async () => {
    await doctor({}, () => {}, async ({ page, context, server }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await banner(page, "ok").waitFor();
      await load(page, CHECK_RAW);
      await page.getByRole("table", { name: "1staid check results" }).waitFor();
      const before = server.requests.length;
      await page.getByRole("button", { name: "Copy as JSON" }).click();
      await page.getByRole("status").filter({ hasText: "Copied to the clipboard." }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), CHECK_RAW);
      assert.equal(server.requests.length, before);
    });
  });

  test("compact layout shows a list instead of a table; German", async () => {
    await doctor({ width: 400, locale: "de-DE" }, () => {}, async ({ page }) => {
      await page.getByLabel("1staid-Ergebnis laden (JSON-Datei)").setInputFiles({ name: "c.json", mimeType: "application/json", buffer: Buffer.from(CHECK_RAW) });
      const list = page.getByRole("list", { name: "1staid-Prüfergebnisse" });
      await list.waitFor();
      assert.equal(await page.getByRole("table").count(), 0);
      assert.equal(await list.getByRole("listitem").count(), CHECK_DOC.checks.length);
      assert.match(await list.innerText(), /Fehlgeschlagen/);
      await page.getByRole("button", { name: "Als JSON kopieren" }).waitFor();
      await expectAxeClean(page, "provisioning compact de");
    });
  });
});

describe("auto refresh", opts, () => {
  const start = async (page: Page): Promise<void> => { await page.clock.install(); };

  test("re-checks every 30 s, pauses while the tab is hidden, resumes when visible, stops after leaving the page", async () => {
    await withApp({ hash: "#/doctor" }, async ({ page, server }) => {
      const m = new DoctorMock(server);
      await start(page);
      await signIn(page);
      await banner(page, "ok").waitFor();
      assert.equal(m.hits.health, 1);
      await page.clock.runFor(30_000);
      await until(() => m.hits.health === 2, "second health call");
      assert.equal(m.hits.agents, 2);

      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.clock.runFor(120_000);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(m.hits.health, 2, "no checks while hidden");

      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await until(() => m.hits.health === 3, "refresh on becoming visible (data was stale)");
      await page.clock.runFor(30_000);
      await until(() => m.hits.health === 4, "regular refresh after resuming");

      await page.getByRole("navigation").getByRole("link", { name: "Projects", exact: true }).click();
      await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
      await page.clock.runFor(120_000);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(m.hits.health, 4, "the timer died with the page");
    });
  });

  test("a failing refresh keeps the last data visible and flips the banner when the state changes", async () => {
    await withApp({ hash: "#/doctor" }, async ({ page, server }) => {
      const m = new DoctorMock(server);
      await start(page);
      await signIn(page);
      await banner(page, "ok").waitFor();
      m.health = { status: 200, body: HEALTH_DEGRADED };
      await page.clock.runFor(30_000);
      await banner(page, "degraded").waitFor();
      m.health = { status: 503, body: HEALTH_DOWN };
      await page.clock.runFor(30_000);
      await banner(page, "down").waitFor();
    });
  });
});

describe("layout, size and keyboard", opts, () => {
  for (const width of [400, 960, 1440, 2560]) {
    test(`${width} px: no horizontal scroll, targets large enough, table only when not compact`, async () => {
      await doctor({ width, height: 900, colorScheme: width === 400 || width === 1440 ? "light" : "dark" }, (m) => { m.health = { status: 200, body: HEALTH_DEGRADED }; }, async ({ page }) => {
        await banner(page, "degraded").waitFor();
        await page.getByLabel("Load a 1staid check result (JSON file)").setInputFiles({ name: "c.json", mimeType: "application/json", buffer: Buffer.from(CHECK_RAW) });
        await page.getByText("run/ is 777, expected 0700").first().waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
        const tables = await page.getByRole("table").count();
        assert.equal(tables, width < 1024 ? 0 : 2, "agents and results are tables in normal and wide, lists in compact");
        const box = await recheck(page).boundingBox();
        assert.ok(box && box.height >= (width < 1024 ? 44 : 24), `Re-check height ${box?.height}`);
        const small = await page.evaluate(() => Array.from(document.querySelectorAll("main *")).filter((e) => e.childNodes.length > 0 && Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).length);
        assert.equal(small, 0, "no text below 12 px");
        await expectAxeClean(page, `layout ${width}`);
      }, { core: CORE_DEGRADED });
    });
  }

  test("everything is reachable and operable with the keyboard", async () => {
    await doctor({}, () => {}, async ({ page, server }, m) => {
      const label = (): Promise<string> => page.evaluate(() => { const e = document.activeElement as HTMLElement | null; return e ? `${e.tagName}:${e.getAttribute("aria-label") ?? e.textContent ?? ""}`.trim() : ""; });
      const tabTo = async (want: RegExp): Promise<void> => {
        for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); if (want.test(await label())) return; }
        throw new Error(`could not tab to ${want}; at ${await label()}`);
      };
      await banner(page, "ok").waitFor();
      await page.locator("main h1").focus();
      await tabTo(/^BUTTON:Re-check$/);
      const before = m.hits.health;
      await page.keyboard.press("Enter");
      await until(() => m.hits.health === before + 1, "re-check by keyboard");
      await tabTo(/^INPUT:/);
      await page.getByLabel("Load a 1staid check result (JSON file)").setInputFiles({ name: "c.json", mimeType: "application/json", buffer: Buffer.from(CHECK_RAW) });
      await page.getByRole("table", { name: "1staid check results" }).waitFor();
      await page.locator("main h1").focus();
      await tabTo(/^BUTTON:Download JSON$/);
      const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
      assert.equal(await readFile(await dl.path(), "utf8"), CHECK_RAW);
      assert.ok(server.requests.length > 0);
    });
  });
});

