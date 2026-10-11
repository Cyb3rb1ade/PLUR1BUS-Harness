import assert from "node:assert/strict";
import { test } from "node:test";
import { renderInline, SafeMarkdown } from "../src/pages/projects/markdown.ts";

test("SafeMarkdown renders text, headers, lists, code and blocks unsafe links", () => {
  // Safe link
  const safeTokens = renderInline("[Link](https://example.com)");
  assert.equal(safeTokens.length, 1);
  const linkVNode = safeTokens[0] as any;
  assert.equal(linkVNode.type, "a");
  assert.equal(linkVNode.props.href, "https://example.com");

  // Unsafe javascript: link is rendered as plain text label
  const unsafeTokens = renderInline("[Malicious](javascript:void)");
  assert.equal(unsafeTokens.length, 1);
  assert.equal(unsafeTokens[0], "Malicious");

  // SafeMarkdown structure
  const md = SafeMarkdown({
    content: "# Heading 1\n\nParagraph with **bold** and `code`.\n\n- item 1\n- item 2\n\n```ts\nconst x = 1;\n```",
  });
  assert.equal(md.type, "div");
  const children = md.props.children as any[];
  assert.equal(children.length, 4);
  assert.equal(children[0].type, "h2");
  assert.equal(children[1].type, "p");
  assert.equal(children[2].type, "ul");
  assert.equal(children[3].type, "pre");
});
