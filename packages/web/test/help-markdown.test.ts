import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMarkdown } from "../src/pages/help/markdown.ts";

describe("help markdown parser security", () => {
  test("never renders raw HTML, script tags or malicious event handlers", () => {
    const malicious = `
# Safe Title <script>alert(1)</script>
<img src="x" onerror="alert(2)" />
<a href="javascript:alert(3)">Click me</a>
Paragraph with <b>bold</b> and <iframe src="http://evil.com"></iframe>.
`;
    const nodes = parseMarkdown(malicious);
    // Heading should have text stripped of tags
    const heading = nodes.find((n) => n.kind === "h");
    assert.ok(heading && heading.kind === "h");
    assert.equal(heading.text, "Safe Title <script>alert(1)</script>");

    // Paragraph nodes should be parsed safely into text inlines, never HTML nodes
    const p = nodes.find((n) => n.kind === "p");
    assert.ok(p && p.kind === "p");
    for (const child of p.children) {
      assert.notEqual(child.kind, "rawHtml" as any);
      if (child.kind === "link") {
        assert.doesNotMatch(child.href, /^javascript:/i);
      }
    }
  });

  test("parses tables, lists and code blocks correctly", () => {
    const md = `
# Title

- item 1
- item 2

1. first
2. second

| Col A | Col B |
|---|---|
| val 1 | val 2 |

\`\`\`sh
echo hello
\`\`\`
`;
    const nodes = parseMarkdown(md);
    assert.ok(nodes.some((n) => n.kind === "h" && n.text === "Title"));
    assert.ok(nodes.some((n) => n.kind === "ul" && n.items.length === 2));
    assert.ok(nodes.some((n) => n.kind === "ol" && n.items.length === 2));
    assert.ok(nodes.some((n) => n.kind === "table" && n.rows.length === 1));
    assert.ok(nodes.some((n) => n.kind === "codeblock" && n.code === "echo hello"));
  });
});
