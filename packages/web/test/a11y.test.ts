import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { browserSkip, setup, signIn, teardown, withApp, type AppOptions } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const axeSource = readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

type Violation = { id: string; impact: string | null; help: string; nodes: { target: unknown[]; html: string }[] };

/** WCAG 2.0/2.1/2.2 A and AA plus axe's best-practice rules. `evaluate` is not subject to the page's CSP, which stays strict. */
async function axe(page: Page): Promise<Violation[]> {
  await page.evaluate(await axeSource);
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Violation[] }> } }).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    });
    return r.violations;
  });
}

function show(v: Violation[]): string {
  return v.map((x) => `${x.id} (${x.impact}): ${x.help}\n${x.nodes.map((n) => `  ${JSON.stringify(n.target)} ${n.html.slice(0, 120)}`).join("\n")}`).join("\n");
}

const WIDTHS = [400, 960, 1440] as const;
const SCHEMES = ["light", "dark"] as const;

async function expectClean(page: Page, label: string): Promise<void> {
  const v = await axe(page);
  assert.equal(v.length, 0, `${label}\n${show(v)}`);
}

describe("axe: sign-in page", opts, () => {
  for (const scheme of SCHEMES) for (const width of WIDTHS) {
    test(`${scheme}, ${width} px`, async () => {
      await withApp({ colorScheme: scheme, width, height: 800 }, async ({ page }) => {
        await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
        await expectClean(page, "sign-in");
      });
    });
  }

  test("with an error message shown (German)", async () => {
    await withApp({ locale: "de-DE" }, async ({ page }) => {
      await page.getByLabel("Benutzername").fill("alice");
      await page.getByLabel("Passwort", { exact: true }).fill("falsch");
      await page.getByRole("button", { name: "Anmelden" }).click();
      await page.getByRole("alert").filter({ hasText: "stimmt nicht" }).waitFor();
      await expectClean(page, "sign-in error de");
    });
  });
});

describe("axe: shell", opts, () => {
  const shell = async (o: AppOptions, run: (page: Page) => Promise<void>): Promise<void> => {
    await withApp(o, async ({ page }) => {
      await signIn(page, undefined, undefined, o.locale?.startsWith("de") ? "de" : "en");
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await run(page);
    });
  };

  for (const scheme of SCHEMES) for (const width of WIDTHS) {
    test(`${scheme}, ${width} px`, async () => {
      await shell({ colorScheme: scheme, width, height: 800 }, (page) => expectClean(page, "shell"));
    });
  }

  test("compact: overlay sidebar open", async () => {
    await shell({ width: 400, height: 800 }, async (page) => {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.locator(".sidebar[data-open=true]").waitFor();
      await expectClean(page, "overlay");
    });
  });

  test("compact: More menu open", async () => {
    await shell({ width: 400, height: 800, colorScheme: "dark" }, async (page) => {
      await page.getByRole("button", { name: "More" }).click();
      await page.locator("#more-panel").waitFor();
      await expectClean(page, "more menu");
    });
  });

  test("not-found page and German shell", async () => {
    await shell({ locale: "de-DE" }, async (page) => {
      await expectClean(page, "shell de");
      await page.evaluate(() => { location.hash = "#/nirgendwo"; });
      await page.getByRole("heading", { name: "Seite nicht gefunden", level: 1 }).waitFor();
      await expectClean(page, "not found de");
    });
  });
});

// M3 acceptance 7 also names full keyboard traversal.
describe("keyboard", opts, () => {
  test("sign-in is operable by keyboard alone", async () => {
    await withApp({}, async ({ page }) => {
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      await page.getByLabel("Username").focus();
      await page.keyboard.type("alice");
      await page.keyboard.press("Tab");
      await page.keyboard.type("correct horse battery");
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
    });
  });

  test("focus ring: every interactive element shows a 2 px outline on keyboard focus", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        const r = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const s = getComputedStyle(el);
          return { id: `${el.tagName}:${(el.textContent ?? "").trim().slice(0, 20)}`, outline: s.outlineStyle, w: parseFloat(s.outlineWidth), body: el === document.body };
        });
        if (r.body) break;
        seen.add(r.id);
        assert.equal(r.outline, "solid", `no focus ring on ${r.id}`);
        assert.ok(r.w >= 2, `focus ring too thin on ${r.id}`);
      }
      assert.ok(seen.size >= 17, `traversed ${seen.size} stops`); // skip + menu + wordmark + 13 links + selects + sign out
    });
  });
});
