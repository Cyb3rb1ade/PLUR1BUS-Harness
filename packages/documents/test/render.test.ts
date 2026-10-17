import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assembleHtml, renderDocument, type BrowserPort } from "../src/render.ts";
import { hasEmbeddedFonts } from "../src/fonts.ts";
import { sanitizeHtml } from "../src/sanitize.ts";

/** A minimal, valid PDF header so a downstream reader sees a real PDF (not a magic-byte stub). */
const STUB_PDF = Buffer.from("%PDF-1.4\n%stub\n%%EOF\n", "ascii");

function fakeBrowser(capture: (html: string) => void): BrowserPort {
  return {
    async printToPdf(html) {
      capture(html);
      return new Uint8Array(STUB_PDF);
    },
  };
}

describe("render", () => {
  it("renders a document to PDF through the injected browser port", async () => {
    let seen = "";
    const result = await renderDocument(
      { template: "report", content: "# Overview\n\nBody text.", title: "Quarterly Report" },
      fakeBrowser((html) => (seen = html)),
      new AbortController().signal,
    );
    assert.equal(Buffer.from(result.pdf).subarray(0, 5).toString("ascii"), "%PDF-");
    assert.match(seen, /Quarterly Report/);
  });

  it("embeds the OFL fonts as data: URLs (fonts embedded, no external fetch)", () => {
    if (!hasEmbeddedFonts()) return; // partial checkout without the font assets
    const html = assembleHtml({ template: "report", content: "# T", title: "T" });
    assert.match(html, /@font-face\s*\{/);
    assert.match(html, /data:font\/ttf;base64,/);
    assert.ok(html.includes('font-family: "Inter"'));
    assert.ok(html.includes('font-family: "Source Serif 4"'));
    assert.ok(html.includes('font-family: "JetBrains Mono"'));
  });

  it("hands the browser only self-contained HTML (no script, no external resource)", async () => {
    let seen = "";
    await renderDocument(
      { template: "one-pager", content: "<script>alert(1)</script>\n\n![x](https://evil.example/x.png)", title: "T" },
      fakeBrowser((html) => (seen = html)),
      new AbortController().signal,
    );
    assert.doesNotMatch(seen, /<\s*script/i);
    assert.doesNotMatch(seen, /https?:\/\//i);
  });
});

describe("sanitizeHtml", () => {
  it("strips script elements and their contents, iframes and event handlers", () => {
    const clean = sanitizeHtml(`<div onclick="x()">ok</div><script>alert(1)</script><iframe src="https://e"></iframe>`);
    assert.doesNotMatch(clean, /<\s*script/i);
    assert.doesNotMatch(clean, /<\s*iframe/i);
    assert.doesNotMatch(clean, /onclick/i);
    assert.ok(clean.includes("ok"));
  });

  it("strips network, javascript: and file: URLs from src/href", () => {
    const clean = sanitizeHtml(`<a href="https://x">x</a><a href="#frag">f</a><img src="javascript:alert(1)"><img src="file:///etc/passwd">`);
    assert.doesNotMatch(clean, /https:\/\//i);
    assert.doesNotMatch(clean, /javascript:/i);
    assert.doesNotMatch(clean, /file:\/\//i);
    assert.ok(clean.includes('href="#frag"'));
  });
});
