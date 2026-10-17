import { existsSync } from "node:fs";
import { chromium } from "playwright";
/** Required CI mode uses only the lockfile's Playwright browser revision, including served-stack tests. */
export function findChromium(): string | undefined {
  const candidates = process.env.PLUR1BUS_WEB_E2E_REQUIRED === "1"
    ? [chromium.executablePath()]
    : [process.env.PLUR1BUS_CHROMIUM, chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/opt/pw-browsers/chromium"];
  return candidates.find((path): path is string => !!path && existsSync(path));
}
