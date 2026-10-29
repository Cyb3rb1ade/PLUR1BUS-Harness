import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildWeb } from "../build.ts";
import { MockHarnessServer, OWNER_TOKEN, type MockOptions } from "./mock-server.ts";

import { BROWSER_OFF_REASON, browserOff, findChromium } from "./browser-runtime.ts";

const executablePath = findChromium();
/** `skip` option for node:test; the browser tests need a Chromium that CI's plain `pnpm test` job may not have. */
export const browserSkip: string | false = executablePath ? false : browserOff() ? BROWSER_OFF_REASON : "no Chromium found (set PLUR1BUS_CHROMIUM)";
if (browserOff() && process.env.PLUR1BUS_WEB_E2E_REQUIRED === "1") throw new Error("PLUR1BUS_WEB_BROWSER=off conflicts with PLUR1BUS_WEB_E2E_REQUIRED=1 (required mode must run the browser suites)");
if (!executablePath && process.env.PLUR1BUS_WEB_E2E_REQUIRED === "1") throw new Error("PLUR1BUS_WEB_E2E_REQUIRED=1 but no Chromium was found");

let distDir: string | undefined;
let browser: Browser | undefined;

/** One build and one browser per test file (node --test runs each file in its own process). */
export async function setup(): Promise<void> {
  distDir = await mkdtemp(join(tmpdir(), "p1web-dist-"));
  await buildWeb(distDir, { gallery: true });
  if (executablePath) {
    browser = await chromium.launch({ executablePath, headless: true });
    await warmUp(browser);
  }
}

/** Opens and closes one page of the built app before the first test. The first page of a fresh browser is the slowest (renderer,
 *  network and font start-up), and on a shared macOS runner that cost landed on the first test of a file, which met its waits
 *  cold: the first tests of `setup-wizard`, `lazy-pages` and `switchboard-robustness` were the ones that failed there. A failure
 *  here is not reported; the tests that follow fail with their own message if the browser does not work. */
async function warmUp(b: Browser): Promise<void> {
  const server = new MockHarnessServer({ distDir: getDistDir() });
  try {
    const baseUrl = await server.start();
    const context = await b.newContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto(baseUrl + "/");
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
    } finally {
      await context.close();
    }
  } catch {
    // see above
  } finally {
    await server.stop();
  }
}
export async function teardown(): Promise<void> {
  await browser?.close();
  if (distDir) await rm(distDir, { recursive: true, force: true });
}
export const getDistDir = (): string => { if (!distDir) throw new Error("setup() not called"); return distDir; };

export type AppOptions = {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  colorScheme?: "light" | "dark" | "no-preference";
  locale?: string;
  /** IANA zone of the browser context; default is the machine's own (CI runs in UTC). */
  timezoneId?: string;
  reducedMotion?: "reduce" | "no-preference";
  server?: Partial<MockOptions>;
  /** Navigate here (hash) instead of the root. */
  hash?: string;
};
export type App = { page: Page; context: BrowserContext; server: MockHarnessServer; baseUrl: string; problems: string[] };

export const TOKEN = OWNER_TOKEN;
export const WRONG_TOKEN = "wrong-token-0123456789abcdef0123456789abcdef";

/** Playwright's default timeout for every action and wait of a test page. The macOS job raises it (`PLUR1BUS_WEB_ACTION_TIMEOUT_MS`):
 *  a shared runner now and then stalls a page for seconds, which fails a wait that is not wrong (docs/ci.md, "macOS browser suites"). */
export const ACTION_TIMEOUT_MS = ((): number => {
  const n = Number(process.env.PLUR1BUS_WEB_ACTION_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 1000 ? n : 5000;
})();
/** One `withApp` call may take this long. Several Playwright calls have no timeout (keyboard.*, evaluate, newContext, newPage,
 *  context.close), so a browser that stops answering would otherwise run into the 120 s limit of node:test, which cancels the
 *  whole file without saying where it stood. The longest legitimate test takes about 20 s. */
const APP_DEADLINE_MS = 100_000;

export async function withApp(opts: AppOptions, run: (app: App) => Promise<void>): Promise<void> {
  let stage = "starting the mock server";
  let where: Page | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`withApp: still ${stage} after ${APP_DEADLINE_MS / 1000} s${where ? ` (page at ${where.url()})` : ""}; a Playwright call without a timeout or the browser itself does not answer`)), APP_DEADLINE_MS);
  });
  try {
    await Promise.race([runApp(opts, run, (s, p) => { stage = s; where ??= p; }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function runApp(opts: AppOptions, run: (app: App) => Promise<void>, at: (stage: string, page?: Page) => void): Promise<void> {
  if (!browser) throw new Error("no browser");
  const server = new MockHarnessServer({ distDir: getDistDir(), ...opts.server });
  const baseUrl = await server.start();
  at("opening the browser context");
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
    deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    colorScheme: opts.colorScheme ?? "no-preference",
    locale: opts.locale ?? "en-US",
    ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}),
    reducedMotion: opts.reducedMotion ?? "no-preference",
  });
  at("opening the page");
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  // Console errors and uncaught exceptions fail a test that checks `problems`. A CSP violation is a console error
  // ("Refused to ..."); the browser's own "Failed to load resource" line for an expected 401/429 is not a page problem.
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  try {
    at("loading the app", page);
    await page.goto(baseUrl + "/" + (opts.hash ?? ""));
    at("running the test");
    await run({ page, context, server, baseUrl, problems });
  } finally {
    at("closing the browser context");
    await context.close();
    at("stopping the mock server");
    await server.stop();
  }
}

export async function signIn(page: Page, token = TOKEN, lang: "en" | "de" = "en"): Promise<void> {
  const l = lang === "de" ? { field: "Owner-Token", go: "Anmelden" } : { field: "Owner token", go: "Sign in" };
  await page.getByLabel(l.field, { exact: true }).fill(token);
  await page.getByRole("button", { name: l.go }).click();
}

/** Sign in and open a (gallery or page) route by hash; resolves when the shell is up. */
export async function openRoute(page: Page, hash: string, lang: "en" | "de" = "en"): Promise<void> {
  await signIn(page, TOKEN, lang);
  await page.locator(".sidebar").waitFor();
  await page.locator("main h1").first().waitFor();
  await page.evaluate((h) => { location.hash = h; }, hash);
}

/** Polls `cond` (a check on the mock server's records) until it holds; fails after `ms` with `what`. node:test does not stop
 *  a failed test function, so a poll without this bound would keep the file's process, and the whole run, alive. */
export async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
