import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildWeb } from "../build.ts";
import { MockHarnessServer, OWNER_TOKEN, type MockOptions } from "./mock-server.ts";

/** Chromium: PLUR1BUS_CHROMIUM, else Playwright's own install, else the container's /opt/pw-browsers/chromium. No download. */
function findChromium(): string | undefined {
  const candidates = [process.env.PLUR1BUS_CHROMIUM, chromium.executablePath(), "/opt/pw-browsers/chromium"];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

const executablePath = findChromium();
/** `skip` option for node:test; the browser tests need a Chromium that CI's plain `pnpm test` job may not have. */
export const browserSkip: string | false = executablePath ? false : "no Chromium found (set PLUR1BUS_CHROMIUM)";
if (!executablePath && process.env.PLUR1BUS_WEB_E2E_REQUIRED === "1") throw new Error("PLUR1BUS_WEB_E2E_REQUIRED=1 but no Chromium was found");

let distDir: string | undefined;
let browser: Browser | undefined;

/** One build and one browser per test file (node --test runs each file in its own process). */
export async function setup(): Promise<void> {
  distDir = await mkdtemp(join(tmpdir(), "p1web-dist-"));
  await buildWeb(distDir);
  if (executablePath) browser = await chromium.launch({ executablePath, headless: true });
}
export async function teardown(): Promise<void> {
  await browser?.close();
  if (distDir) await rm(distDir, { recursive: true, force: true });
}
export const getDistDir = (): string => { if (!distDir) throw new Error("setup() not called"); return distDir; };

export type AppOptions = {
  width?: number;
  height?: number;
  colorScheme?: "light" | "dark" | "no-preference";
  locale?: string;
  reducedMotion?: "reduce" | "no-preference";
  server?: Partial<MockOptions>;
  /** Navigate here (hash) instead of the root. */
  hash?: string;
};
export type App = { page: Page; context: BrowserContext; server: MockHarnessServer; baseUrl: string; problems: string[] };

export const TOKEN = OWNER_TOKEN;
export const WRONG_TOKEN = "wrong-token-0123456789abcdef0123456789abcdef";

export async function withApp(opts: AppOptions, run: (app: App) => Promise<void>): Promise<void> {
  if (!browser) throw new Error("no browser");
  const server = new MockHarnessServer({ distDir: getDistDir(), ...opts.server });
  const baseUrl = await server.start();
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
    colorScheme: opts.colorScheme ?? "no-preference",
    locale: opts.locale ?? "en-US",
    reducedMotion: opts.reducedMotion ?? "no-preference",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  // Console errors and uncaught exceptions fail a test that checks `problems`. A CSP violation is a console error
  // ("Refused to ..."); the browser's own "Failed to load resource" line for an expected 401/429 is not a page problem.
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  try {
    await page.goto(baseUrl + "/" + (opts.hash ?? ""));
    await run({ page, context, server, baseUrl, problems });
  } finally {
    await context.close();
    await server.stop();
  }
}

export async function signIn(page: Page, token = TOKEN, lang: "en" | "de" = "en"): Promise<void> {
  const l = lang === "de" ? { field: "Owner-Token", go: "Anmelden" } : { field: "Owner token", go: "Sign in" };
  await page.getByLabel(l.field, { exact: true }).fill(token);
  await page.getByRole("button", { name: l.go }).click();
}
