// Layout checks (overflow, widow, empty page) need a real layout engine; these run against Chromium and are skipped when no
// binary is present (`PLUR1BUS_DOCUMENTS_E2E_REQUIRED=1` turns the skip into a failure). The seeded defects below are exactly
// the acceptance set of D100 §3.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { automaticChecks, LAYOUT_CHECK_SCRIPT, createChromiumBrowser, type ReviewBrowser } from "../src/index.ts";

function findChromium(): string | null {
  const env = process.env.PLUR1BUS_CHROMIUM_BIN;
  if (env) return env;
  for (const c of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/opt/homebrew/bin/google-chrome"]) {
    try { accessSync(c, constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

function seeded(defect: string): string {
  if (defect === "overflow") {
    return `<!doctype html><html><head><style>.box { width: 120px; height: 20px; overflow: hidden; white-space: nowrap; }</style></head><body><div class="box">This text is far too long to fit inside a 120 pixel box</div></body></html>`;
  }
  if (defect === "widow") {
    return `<!doctype html><html><head><style>p { width: 18ch; }</style></head><body><p>one two three four five six seven eight nine ten eleven widow</p></body></html>`;
  }
  if (defect === "empty-page") {
    return `<!doctype html><html><head><style>.pb { break-after: page; }</style></head><body><div class="pb">page one</div><div class="pb"></div><div>page two</div></body></html>`;
  }
  throw new Error(`unknown defect ${defect}`);
}

describe("layout checks (real Chromium, seeded defects)", () => {
  const bin = findChromium();
  const required = process.env.PLUR1BUS_DOCUMENTS_E2E_REQUIRED === "1";
  it("has a Chromium binary", { skip: !bin && !required }, () => assert.ok(bin));

  for (const defect of ["overflow", "widow", "empty-page"] as const) {
    it(`catches the seeded ${defect} defect`, { skip: !bin, timeout: 120_000 }, async () => {
      const browser = createChromiumBrowser({ bin: bin! }) as ReviewBrowser;
      const html = seeded(defect);
      const layout = await browser.evaluate!(html, LAYOUT_CHECK_SCRIPT, new AbortController().signal) as { check: string; message: string }[];
      assert.ok(
        layout.some((f) => f.check === defect),
        `${defect}: expected a finding, got ${JSON.stringify(layout)}`,
      );
    });
  }

  it("automaticChecks finds no overflow in a clean document", { skip: !bin, timeout: 120_000 }, async () => {
    const browser = createChromiumBrowser({ bin: bin! }) as ReviewBrowser;
    const html = "<!doctype html><html><body><p>A normal paragraph with enough room.</p></body></html>";
    const findings = await automaticChecks(html, browser, new AbortController().signal);
    assert.ok(!findings.some((f) => f.check === "overflow"), JSON.stringify(findings));
  });
});
