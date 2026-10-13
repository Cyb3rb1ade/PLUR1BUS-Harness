// Step 11 (Home) of the server hardening sweep, against the mock API in a real Chromium (skipped, with a reason, where none
// is found; PLUR1BUS_WEB_E2E_REQUIRED=1 makes that a failure). Already pinned elsewhere (not repeated): the wordmark opens Home,
// empty placeholder links are hidden, the known URLs, version and core facts on the happy path (home-page.test.ts,
// home-links.test.ts).
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { ALL_ITEMS, HIDDEN_ITEMS } from "../src/nav.ts";
import { DOCS_INDEX as DE_DOCS } from "../src/pages/help/docs-bundle/de-index.ts";
import { DOCS_INDEX as EN_DOCS } from "../src/pages/help/docs-bundle/en-index.ts";
import { de, en } from "../src/i18n/home-help-library.ts";
import { getActiveExternalLinks, HOME_EXTERNAL_LINKS } from "../src/pages/home/links.ts";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import type { MockHarnessServer } from "./mock-server.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

// ---- the links ---------------------------------------------------------------------------------------------------------

describe("home links point at things that exist", () => {
  test("every internal link names a route of the app and, for the help pages, a bundled document in both languages; every external one is https without credentials", () => {
    const routes = new Set([...ALL_ITEMS, ...HIDDEN_ITEMS].map((i) => i.path.replace(/^\//, "")));
    const hosts = new Set(["github.com", "plur1bus.app"]);
    for (const link of getActiveExternalLinks()) {
      if (link.url.startsWith("#/")) {
        const [route, slug, ...rest] = link.url.slice(2).split("/");
        assert.ok(route && routes.has(route), `${link.id}: no route ${route}`); assert.equal(rest.length, 0, `${link.id}: extra path segments`);
        if (route === "help") { assert.ok(slug, `${link.id}: a help link names a page`); for (const [lang, index] of [["en", EN_DOCS], ["de", DE_DOCS]] as const) assert.ok(index.some((d) => d.slug === slug), `${link.id}: no ${lang} document "${slug}"`); }
      } else {
        const u = new URL(link.url); assert.equal(u.protocol, "https:", link.id); assert.equal(u.username + u.password, "", link.id); assert.ok(hosts.has(u.hostname), `${link.id}: ${u.hostname}`); assert.equal(u.search + u.hash, "", `${link.id}: no query or fragment`);
      }
    }
    assert.equal(new Set(HOME_EXTERNAL_LINKS.map((l) => l.id)).size, HOME_EXTERNAL_LINKS.length, "link ids are unique");
  });

  test("every label key exists in both catalogues, and the German text is not the English text for anything that is not a name", () => {
    const brand = new Set(["home.links.repoHarness", "home.links.repoHostAddons", "home.links.repoMemory"]);
    for (const link of HOME_EXTERNAL_LINKS) { const k = link.labelKey; assert.ok(en[k] && de[k], `${k} is missing in a catalogue`); if (!brand.has(k)) assert.notEqual(en[k], de[k], `${k} is not translated`); }
  });

  test("the status card has no English word hard-wired into the page: every word it shows comes from the catalogues", () => {
    for (const key of ["home.status.connected", "home.status.disconnected", "home.status.yes", "home.status.no", "home.status.forbidden", "home.status.unknown"] as const) {
      assert.ok((en as Record<string, string>)[key], `en: ${key}`); assert.ok((de as Record<string, string>)[key], `de: ${key}`); assert.notEqual((en as Record<string, string>)[key], (de as Record<string, string>)[key], `${key} is not translated`);
    }
  });
});

// ---- the status card -----------------------------------------------------------------------------------------------------

type Health = { status: number; body?: unknown; delayMs?: number };
const OK_HEALTH: Health = { status: 200, body: { schema: "health/1", status: "ok", api: { version: "1.4.2" }, core: { reachable: true, uptimeMs: 125_000, engineReady: true, degraded: false } } };
const err = (status: number, error: string, reason: string): Health => ({ status, body: { schema: "error/1", error, message: reason, reason } });
function serveHealth(server: MockHarnessServer, answer: () => Health): { count: () => number } {
  let n = 0;
  server.extensions.unshift(async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (path !== "/api/v1/health") return false;
    n++; const a = answer(); if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
    res.writeHead(a.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(a.body ?? {})); return true;
  });
  return { count: () => n };
}
const CORE_OK = { process: { state: "running" }, engine: { ready: true, degraded: null, models: { embedder: { state: "ready" } } } };
const ROLES = ["owner", "admin", "operator", "member", "viewer"] as const;
const MAY_SEE_HEALTH = new Set(["owner", "admin", "operator"]); // doctor.read, docs/api.md and docs/rbac.md

describe("home status card: states per role and per failure, none of them blocks the page", () => {
  for (const role of ROLES) {
    test(`${role}: the card says what is true for this role`, opts, async () => {
      await withApp({ server: { role } }, async ({ page, server, problems }) => {
        const allowed = MAY_SEE_HEALTH.has(role);
        const health = serveHealth(server, () => (allowed ? OK_HEALTH : err(403, "E_DENIED", "role-denied")));
        server.rpc.handle("core.status", () => CORE_OK, { write: false }); if (!allowed) server.rpc.scenario("core.status", "forbidden");
        await openRoute(page, "#/home"); await page.getByRole("heading", { name: "Welcome to PLUR1BUS", level: 1 }).waitFor();
        await page.locator(".home-link").first().waitFor();
        assert.ok((await page.locator(".home-link").count()) >= 4, "the links card is there for every role");
        const text = async () => (await page.locator("main").innerText());
        if (allowed) { await page.getByText("Connected", { exact: true }).waitFor(); assert.match(await text(), /1\.4\.2/); }
        else {
          await page.waitForFunction(() => !document.querySelector(".home-status-facts [role=status], [data-state=loading]"));
          const body = await text(); assert.ok(!/Disconnected/.test(body), `a role that may not look is not told the core is disconnected:\n${body}`);
          assert.match(body, /not available|your role|permission/i, "and is told why there is nothing to show");
        }
        assert.ok(health.count() <= 2, `${health.count()} health requests for one page view`); assert.deepEqual(problems, []);
      });
    });
  }

  test("the core is down (health 503, core.status unavailable): the card says disconnected, offers Try again, and recovers when the core is back", opts, async () => {
    await withApp({}, async ({ page, server }) => {
      let up = false; const health = serveHealth(server, () => (up ? OK_HEALTH : err(503, "E_CORE_UNAVAILABLE", "core-unreachable")));
      server.rpc.handle("core.status", () => CORE_OK, { write: false }); server.rpc.scenario("core.status", "unavailable");
      await openRoute(page, "#/home"); await page.getByText("Disconnected", { exact: true }).waitFor();
      assert.equal(await page.getByText("Disconnected", { exact: true }).count(), 1);
      const retry = page.getByRole("button", { name: /try again/i }); await retry.waitFor();
      up = true; server.rpc.scenario("core.status", "success"); await retry.click();
      await page.getByText("Connected", { exact: true }).waitFor(); assert.ok(health.count() >= 2);
    });
  });

  test("one source failing is not the core being disconnected: with health broken but core.status answering, the card shows what core.status says", opts, async () => {
    await withApp({}, async ({ page, server }) => {
      serveHealth(server, () => err(500, "E_INTERNAL", "boom")); server.rpc.handle("core.status", () => CORE_OK, { write: false });
      await openRoute(page, "#/home"); await page.getByText("Connected", { exact: true }).waitFor(); assert.equal(await page.getByText("Disconnected", { exact: true }).count(), 0);
      await page.getByText("running", { exact: true }).waitFor();
    });
  });

  test("a version nobody told the page is not invented: without a health answer the card shows no version number", opts, async () => {
    await withApp({}, async ({ page, server }) => {
      serveHealth(server, () => err(503, "E_CORE_UNAVAILABLE", "core-unreachable")); server.rpc.handle("core.status", () => CORE_OK, { write: false });
      await openRoute(page, "#/home"); await page.getByText("Connected", { exact: true }).waitFor();
      assert.ok(!/\b0\.1\.0\b/.test(await page.locator("main").innerText()), "the page printed 0.1.0 without having been told it");
    });
  });

  test("a slow status never holds the links back: they are on screen at once, the status says it is loading, and the answer fills it in", opts, async () => {
    await withApp({}, async ({ page, server }) => {
      serveHealth(server, () => ({ ...OK_HEALTH, delayMs: 1500 })); server.rpc.handle("core.status", () => CORE_OK, { write: false }); server.rpc.setDelay("core.status", 1500);
      await openRoute(page, "#/home"); await page.locator(".home-link").first().waitFor();
      assert.ok((await page.locator(".home-link").count()) >= 4); await page.locator("[role=status][aria-busy=true]").waitFor();
      await page.getByText("Connected", { exact: true }).waitFor({ timeout: 8000 }); assert.equal(await page.locator("[role=status][aria-busy=true]").count(), 0);
    });
  });

  test("garbage answers (wrong types, a string for the core, huge numbers, hostile text) render as plain text or nothing, never break the page or inject markup", opts, async () => {
    await withApp({}, async ({ page, server, problems }) => {
      serveHealth(server, () => ({ status: 200, body: { api: { version: "<img src=x onerror=alert(1)>" }, core: { reachable: "yes", uptimeMs: "soon", engineReady: "no", degraded: 5 } } }));
      server.rpc.handle("core.status", () => ({ process: { state: "<script>window.__pwned=1</script>" }, engine: { ready: "x", degraded: [], models: { a: null } } }), { write: false });
      await openRoute(page, "#/home"); await page.getByRole("heading", { name: "Welcome to PLUR1BUS", level: 1 }).waitFor(); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined); assert.equal(await page.locator("main img, main script").count(), 0);
      assert.ok((await page.locator(".home-link").count()) >= 4); assert.deepEqual(problems.filter((p) => !/onerror|Refused to/.test(p)), []);
    });
  });
});

describe("home in German", opts, () => {
  test("everything the status card says is German, in every state", async () => {
    for (const mode of ["ok", "down"] as const) {
      await withApp({ locale: "de-DE" }, async ({ page, server }) => {
        serveHealth(server, () => (mode === "ok" ? OK_HEALTH : err(503, "E_CORE_UNAVAILABLE", "core-unreachable"))); server.rpc.handle("core.status", () => CORE_OK, { write: false }); if (mode === "down") server.rpc.scenario("core.status", "unavailable");
        await openRoute(page, "#/home", "de"); await page.getByRole("heading", { name: "Willkommen bei PLUR1BUS", level: 1 }).waitFor(); await page.waitForTimeout(500);
        const body = await page.locator("main").innerText();
        for (const word of ["Connected", "Disconnected", "Yes", "No", "Core Status", "Engine Ready", "Try again", "Loading"]) assert.ok(!new RegExp(`\\b${word}\\b`).test(body), `${mode}: the English "${word}" is on the German page:\n${body}`);
        assert.match(body, mode === "ok" ? /Verbunden/ : /Getrennt|nicht erreichbar/i);
      });
    }
  });
});

// ---- accessibility, keyboard, layout ------------------------------------------------------------------------------------

describe("home is accessible and usable on small and large screens", () => {
  for (const [width, scheme, lang] of [[1440, "light", "en"], [360, "dark", "en"], [1440, "dark", "de"], [320, "light", "de"]] as const) {
    test(`axe finds nothing (${width} px, ${scheme}, ${lang}), in the working state and the failing one`, opts, async () => {
      for (const failing of [false, true]) {
        await withApp({ width, colorScheme: scheme, locale: lang === "de" ? "de-DE" : "en-US", server: { role: failing ? "viewer" : "owner" } }, async ({ page, server }) => {
          serveHealth(server, () => (failing ? err(403, "E_DENIED", "role-denied") : OK_HEALTH)); server.rpc.handle("core.status", () => CORE_OK, { write: false }); if (failing) server.rpc.scenario("core.status", "forbidden");
          await openRoute(page, "#/home", lang); await page.locator("main h1").first().waitFor(); await page.locator(".home-link").first().waitFor(); await page.waitForTimeout(500);
          await expectAxeClean(page, `home ${failing ? "forbidden" : "ok"} ${width}px ${scheme} ${lang}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert.ok(overflow <= 0, `horizontal scrolling of ${overflow}px at ${width}px`);
        });
      }
    });
  }

  test("the links are reachable and usable with the keyboard alone, each shows a focus ring, and Enter follows an internal one", opts, async () => {
    await withApp({}, async ({ page, server }) => {
      serveHealth(server, () => OK_HEALTH); server.rpc.handle("core.status", () => CORE_OK, { write: false });
      await openRoute(page, "#/home"); await page.getByText("Connected", { exact: true }).waitFor();
      const hrefs = await page.locator(".home-link").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
      await page.locator("main h1").first().focus(); const seen: string[] = [];
      for (let i = 0; i < 60 && seen.length < hrefs.length; i++) { await page.keyboard.press("Tab"); const h = await page.evaluate(() => { const a = document.activeElement; return a?.classList.contains("home-link") ? { href: a.getAttribute("href"), outline: getComputedStyle(a).outlineStyle + getComputedStyle(a).outlineWidth + getComputedStyle(a).boxShadow } : null; }); if (h) { seen.push(h.href!); assert.ok(!/^none0px(none)?$/.test(h.outline) && h.outline !== "none0pxnone", `no visible focus on ${h.href}: ${h.outline}`); } }
      assert.deepEqual(seen, hrefs, "Tab visits every link once, in reading order");
      await page.locator('.home-link[href="#/help/quickstart"]').focus(); await page.keyboard.press("Enter"); await page.waitForFunction(() => location.hash === "#/help/quickstart");
      await page.locator("main h1").first().waitFor(); assert.notEqual((await page.locator("main h1").first().innerText()).trim(), "");
    });
  });

  test("every internal link opens a real page (not the 404), and every external one opens in a new context without handing over the opener", opts, async () => {
    await withApp({}, async ({ page, server }) => {
      serveHealth(server, () => OK_HEALTH); server.rpc.handle("core.status", () => CORE_OK, { write: false });
      await openRoute(page, "#/home"); await page.locator(".home-link").first().waitFor();
      const links = await page.locator(".home-link").evaluateAll((els) => els.map((e) => ({ href: e.getAttribute("href")!, target: e.getAttribute("target"), rel: e.getAttribute("rel") })));
      for (const l of links) {
        if (l.href.startsWith("#/")) { await page.evaluate((h) => { location.hash = h; }, l.href); await page.locator("main h1").first().waitFor(); const title = (await page.locator("main h1").first().innerText()).trim(); assert.ok(title !== "" && !/not found|404/i.test(title), `${l.href} opened "${title}"`); await page.evaluate(() => { location.hash = "#/home"; }); await page.locator(".home-link").first().waitFor(); }
        else { assert.equal(l.target, "_blank", l.href); assert.match(l.rel ?? "", /noopener/, l.href); assert.match(l.rel ?? "", /noreferrer/, l.href); }
      }
    });
  });
});
