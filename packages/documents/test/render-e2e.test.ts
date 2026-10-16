// Real-Chromium end-to-end render (D100 §2 acceptance): each template renders a valid PDF with embedded fonts. Skipped when
// no Chromium binary is found; `PLUR1BUS_DOCUMENTS_E2E_REQUIRED=1` turns that skip into a failure (the same gate the web
// package uses for its browser suites). Exact page counts are pinned by the golden set (Phase 4); here each template must
// simply produce a non-trivial, well-formed PDF.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { assembleHtml, createChromiumBrowser, TEMPLATE_IDS } from "../src/index.ts";

function findChromium(): string | null {
  const env = process.env.PLUR1BUS_CHROMIUM_BIN;
  if (env) return env;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/homebrew/bin/google-chrome",
  ];
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

const SAMPLE: Record<string, { content: string; meta: Record<string, unknown> }> = {
  report: { content: "# Overview\n\nA report body.\n\n## Findings\n\n- one\n- two\n", meta: { author: "A. Author", date: "2026-10-15" } },
  essay: { content: "# On Documents\n\nAn essay body with a few paragraphs of text.\n\n## Argument\n\nMore text.\n", meta: {} },
  "white-paper": { content: "# A White Paper\n\nExecutive summary.\n\n## Findings\n\nNumbered findings.\n", meta: { author: "A. Author" } },
  proposal: { content: "# Proposal\n\nSummary.\n\n## Scope\n\nScope text.\n", meta: { author: "A. Author" } },
  "one-pager": { content: "# One Pager\n\nA single-page summary.\n", meta: {} },
  letter: { content: "Body of the letter.\n\nSincerely,\n", meta: { from: "Sender", to: "Recipient", date: "2026-10-15", subject: "Re: documents", salutation: "Dear Reader,", closing: "Best regards,", author: "A. Author" } },
  invoice: { content: "Notes for the client.\n", meta: { title: "Invoice", from: "Seller", to: "Buyer", date: "2026-10-15", total: "€ 1.000", lineItems: [{ label: "Work", amount: "€ 1.000" }] } },
  cv: { content: "## Experience\n\nRole and impact.\n", meta: { title: "A. Author", role: "Engineer", author: "a@example.com" } },
  slides: { content: "## Slide one\n\nPoint.\n\n## Slide two\n\nPoint.\n", meta: {} },
};

describe("render (real Chromium)", () => {
  const bin = findChromium();
  const required = process.env.PLUR1BUS_DOCUMENTS_E2E_REQUIRED === "1";
  it("has a Chromium binary available (or the suite is skipped, not silently green)", { skip: !bin && !required }, () => {
    assert.ok(bin, "PLUR1BUS_CHROMIUM_BIN or a system Chrome/Chromium is required");
  });

  for (const template of TEMPLATE_IDS) {
    it(`renders a valid PDF with embedded fonts for ${template}`, { skip: !bin, timeout: 120_000 }, async () => {
      const s = SAMPLE[template]!;
      const html = assembleHtml({ template, content: s.content, title: "E2E Document", subtitle: "A subtitle", meta: s.meta });
      assert.match(html, /data:font\/ttf;base64,/, "fonts are embedded before the browser sees the HTML");
      const pdf = await createChromiumBrowser({ bin: bin! }).printToPdf(html, { signal: new AbortController().signal });
      const bytes = Buffer.from(pdf);
      assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
      assert.ok(bytes.byteLength > 1000, "a rendered PDF is non-trivial");
      assert.ok(bytes.includes("%%EOF"), "the PDF terminates");
      // Fonts were embedded into the PDF (a subset of at least the Inter face is referenced).
      assert.ok(bytes.includes("Inter"), "the PDF embeds a shipped font");
    });
  }
});
