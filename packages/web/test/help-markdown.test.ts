import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { h, type VNode } from "preact";
import { parseMarkdown, renderMarkdown, resolveHref } from "../src/pages/help/markdown.ts";
import { filterIndex, pickDoc, splitSub } from "../src/pages/help/route.ts";
import { DOCS_INDEX as EN_INDEX } from "../src/pages/help/docs-bundle/en-index.ts";
import { DOCS_INDEX as DE_INDEX } from "../src/pages/help/docs-bundle/de-index.ts";

/** All elements of a rendered vnode tree. */
function walk(v: unknown, out: VNode<Record<string, unknown>>[] = []): VNode<Record<string, unknown>>[] {
  if (Array.isArray(v)) { for (const c of v) walk(c, out); return out; }
  if (v && typeof v === "object" && "props" in v) {
    const n = v as VNode<Record<string, unknown>>;
    out.push(n);
    walk(n.props.children, out);
  }
  return out;
}
const anchors = (md: string, opts = {}): VNode<Record<string, unknown>>[] => walk(renderMarkdown(parseMarkdown(md), opts)).filter((n) => n.type === "a");


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

describe("help markdown links", () => {
  const evil = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "  javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "javascript&colon;alert(1)",
    "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "//evil.example/x", "\\\\evil.example\\x", "file:///etc/passwd", "blob:https://x/y",
    "javascript:alert(1)//x.md", "javascript:alert(1)#a.md",
  ];
  for (const href of evil) {
    test(`no navigable target for ${JSON.stringify(href)}`, () => {
      const links = anchors(`[click](${href})`);
      for (const a of links) assert.doesNotMatch(String(a.props.href), /^\s*(javascript|data|vbscript|file|blob):|^\/\/|^\\/i, String(a.props.href));
      assert.equal(links.length, 0, "the link degrades to its text");
    });
  }

  test("http(s) and mailto links open in a new tab without opener; handbook and anchor links stay in the router", () => {
    const [ext, mail] = anchors("[a](https://example.org/x) [m](mailto:ops@example.org)");
    assert.equal(ext?.props.target, "_blank");
    assert.equal(ext?.props.rel, "noopener noreferrer");
    assert.equal(mail?.props.target, "_blank");
    const [doc, anchor, docAnchor] = anchors("[a](operations.md) [b](#directories) [c](../en/operations.md#directories)", { slug: "quickstart" });
    assert.equal(doc?.props.href, "#/help/operations");
    assert.equal(anchor?.props.href, "#/help/quickstart#directories", "a bare #anchor would be taken for a route");
    assert.equal(docAnchor?.props.href, "#/help/operations#directories");
    assert.equal(docAnchor?.props.target, undefined);
  });

  test("a .md link to a document outside the handbook is text, not a dead link", () => {
    const md = "[release guide](../../release.md#attestation) and [ops](operations.md)";
    const links = anchors(md, { hasDoc: (s: string) => s === "operations" });
    assert.deepEqual(links.map((a) => a.props.href), ["#/help/operations"]);
    assert.equal(resolveHref("../../release.md", { hasDoc: () => false }), null);
  });

  test("an external .md URL stays external, not rewritten to a handbook page", () => {
    assert.deepEqual(resolveHref("https://example.org/docs/operations.md"), { href: "https://example.org/docs/operations.md", external: true });
  });

  test("raw HTML in text, link text and code never becomes an element", () => {
    const tree = walk(renderMarkdown(parseMarkdown('<img src=x onerror=alert(1)> [<b>x</b>](https://e.org) `<script>`\n\n| <i>h</i> |\n|---|\n| <u>c</u> |')));
    const tags = new Set(tree.map((n) => String(n.type)));
    for (const bad of ["img", "b", "script", "i", "u", "iframe"]) assert.ok(!tags.has(bad), bad);
  });
});

describe("help markdown parser", () => {
  const text = (md: string): string => {
    const p = parseMarkdown(md)[0];
    assert.equal(p?.kind, "p");
    return p?.kind === "p" ? p.children.map((c) => c.text).join("") : "";
  };

  test("special characters that open nothing are kept", () => {
    assert.equal(text("2 * 3 = 6"), "2 * 3 = 6");
    assert.equal(text("an `unclosed tick"), "an `unclosed tick");
    assert.equal(text("see [brackets] and [x]y (z)"), "see [brackets] and [x]y (z)");
    assert.equal(text("a ** b"), "a ** b");
  });

  test("heading ids are unique and never empty", () => {
    const ids = parseMarkdown("# Setup\n\n## Setup\n\n## Setup\n\n## !!!\n\n## ???").flatMap((n) => (n.kind === "h" ? [n.id] : []));
    assert.deepEqual(ids, ["setup", "setup-1", "setup-2", "section", "section-1"]);
  });

  test("huge and degenerate input terminates quickly", () => {
    const t0 = Date.now();
    parseMarkdown("[".repeat(200_000) + "`".repeat(200_000) + "*".repeat(200_000));
    parseMarkdown(("- " + "*a ".repeat(100) + "\n").repeat(2000));
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });
});

describe("help routing helpers", () => {
  const en = [{ slug: "quickstart", title: "Quickstart" }, { slug: "approvals", title: "Approvals and grants" }];
  const de = [{ slug: "quickstart", title: "Schnellstart" }, { slug: "freigaben", title: "Freigaben" }];

  test("splitSub separates slug and anchor and survives bad escapes", () => {
    assert.deepEqual(splitSub("operations#directories"), { slug: "operations", anchor: "directories" });
    assert.deepEqual(splitSub(undefined), { slug: "", anchor: "" });
    assert.deepEqual(splitSub("a%E0%A4%A#x%"), { slug: "a%E0%A4%A", anchor: "x%" });
    assert.deepEqual(splitSub("ops#gr%C3%BCn"), { slug: "ops", anchor: "grün" });
  });

  test("pickDoc: own language first, English as fallback, else nothing", () => {
    assert.deepEqual(pickDoc("freigaben", de, en), { slug: "freigaben", useFallback: false });
    assert.deepEqual(pickDoc("approvals", de, en), { slug: "approvals", useFallback: true });
    assert.equal(pickDoc("nope", de, en), null);
    assert.deepEqual(pickDoc("", de, en), { slug: "quickstart", useFallback: false });
  });

  test("filterIndex treats the query as plain text", () => {
    assert.equal(filterIndex(en, "").length, 2);
    assert.equal(filterIndex(en, "   ").length, 2);
    assert.deepEqual(filterIndex(en, "APPROV").map((e) => e.slug), ["approvals"]);
    for (const q of ["(", "[a-", ".*", "\\", "a{2,1}", "(?<x", "+"]) assert.deepEqual(filterIndex(en, q), []);
    assert.deepEqual(filterIndex(en, "x".repeat(1_000_000)), []);
  });
});

describe("help docs bundle indices", () => {
  const requiredEn = ["privacy", "cloud-embeddings", "reembed", "chat-models", "secrets", "import-rollback"];
  const requiredDe = ["datenschutz", "cloud-embeddings", "reembed", "chat-modelle", "secrets", "import-rollback"];

  test("contains all new security, privacy and operations topics in English index", () => {
    const slugs = new Set(EN_INDEX.map((e) => e.slug));
    for (const slug of requiredEn) {
      assert.ok(slugs.has(slug), `missing English doc: ${slug}`);
    }
  });

  test("contains all new security, privacy and operations topics in German index", () => {
    const slugs = new Set(DE_INDEX.map((e) => e.slug));
    for (const slug of requiredDe) {
      assert.ok(slugs.has(slug), `missing German doc: ${slug}`);
    }
  });

  test("pickDoc resolves German slugs directly and falls back for English slugs", () => {
    assert.deepEqual(pickDoc("datenschutz", DE_INDEX, EN_INDEX), { slug: "datenschutz", useFallback: false });
    assert.deepEqual(pickDoc("privacy", DE_INDEX, EN_INDEX), { slug: "privacy", useFallback: true });
    assert.deepEqual(pickDoc("chat-modelle", DE_INDEX, EN_INDEX), { slug: "chat-modelle", useFallback: false });
    assert.deepEqual(pickDoc("chat-models", DE_INDEX, EN_INDEX), { slug: "chat-models", useFallback: true });
  });
});

