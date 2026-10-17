import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assembleHtml } from "../src/render.ts";
import { TEMPLATE_IDS } from "../src/templates.ts";

const CONTENT = `# Introduction\n\nA first paragraph with **bold** and *italic* text and a [link](https://example.com).\n\n## Findings\n\n- first point\n- second point\n\n> A pull quote.\n\n\`\`\`\ncode block\n\`\`\`\n`;

describe("templates", () => {
  it("exposes exactly the nine D100 templates", () => {
    assert.deepEqual([...TEMPLATE_IDS].sort(), ["cv", "essay", "invoice", "letter", "one-pager", "proposal", "report", "slides", "white-paper"].sort());
  });

  for (const template of TEMPLATE_IDS) {
    it(`assembles a self-contained ${template} document`, () => {
      const html = assembleHtml({
        template,
        content: CONTENT,
        title: "Example Document",
        subtitle: "A subtitle",
        meta: { author: "A. Author", date: "2026-10-15", from: "Sender", to: "Recipient", total: "€ 1.000", lineItems: [{ label: "Work", amount: "€ 1.000" }] },
      });
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /<h1>/);
      assert.ok(html.includes("Example Document"), "title appears");
      // Content is escaped: the markdown heading becomes real <h2>, but the <script>-free body carries the text.
      assert.ok(html.includes("Findings"), "content sections present");
      assert.ok(html.includes("code block"), "code block present");
    });
  }

  it("never emits a script element from agent content", () => {
    const html = assembleHtml({
      template: "report",
      content: `<script>globalThis.pwned = true</script>\n\n# Title\n\n<img src=x onerror=alert(1)>\n\n<script src="https://evil.example/x.js"></script>`,
      title: "T",
    });
    // The Markdown renderer escapes <script> to &lt;script&gt;; sanitizeHtml would remove a real one. Either way none survives.
    assert.doesNotMatch(html, /<\s*script/i);
    assert.doesNotMatch(html, /onerror\s*=/i);
  });

  it("never references an external resource (no network, only embedded assets)", () => {
    const html = assembleHtml({
      template: "white-paper",
      content: `# T\n\n![x](https://evil.example/pixel.png) and <link rel="stylesheet" href="//cdn.example/x.css">`,
      title: "T",
    });
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /src\s*=\s*["']?\/\//i);
    assert.doesNotMatch(html, /<\s*link/i);
  });
});
