import { existsSync } from "node:fs";
import { chromium } from "playwright";
/**
 * `PLUR1BUS_WEB_BROWSER=off` is the one explicit switch that turns every browser suite of this package off (they report
 * `skipped` with this reason). It exists for the `unit (macos-15)` job: the system Chrome found below made it run the
 * whole browser suite in-line (20+ min), which starved the packages after `web` (core never ran). The suites run in the
 * `web-browser (macos-15)` job instead (docs/ci.md). Nothing else disables them; required mode refuses the switch.
 */
export const BROWSER_SWITCH = "PLUR1BUS_WEB_BROWSER";
export const browserOff = (): boolean => process.env[BROWSER_SWITCH] === "off";
export const BROWSER_OFF_REASON = `browser suites off (${BROWSER_SWITCH}=off); they run in the web-browser job`;
/** Required CI mode uses only the lockfile's Playwright browser revision, including served-stack tests. */
export function findChromium(): string | undefined {
  if (browserOff()) return undefined;
  const candidates = process.env.PLUR1BUS_WEB_E2E_REQUIRED === "1"
    ? [chromium.executablePath()]
    : [process.env.PLUR1BUS_CHROMIUM, chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/opt/pw-browsers/chromium"];
  return candidates.find((path): path is string => !!path && existsSync(path));
}
