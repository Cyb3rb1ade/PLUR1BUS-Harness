import assert from "node:assert/strict";
import { test } from "node:test";
import { safeHref, toMatrixText } from "../src/markdown.ts";

// Table-driven: [name, markdown, expected formatted_body (undefined = plain only), expected body]
const cases: [string, string, string | undefined, string][] = [
  ["plain text has no formatted body", "hello world", undefined, "hello world"],
  ["bold and italic", "**b** and *i*", "<strong>b</strong> and <em>i</em>", "b and i"],
  ["strikethrough", "~~gone~~", "<del>gone</del>", "gone"],
  ["inline code keeps markup literal", "`<b>x</b>`", "<code>&lt;b&gt;x&lt;/b&gt;</code>", "<b>x</b>"],
  [
    "fenced code block with language",
    "```ts\nlet a = 1 < 2;\n```",
    '<pre><code class="language-ts">let a = 1 &lt; 2;</code></pre>',
    "let a = 1 < 2;",
  ],
  ["fence without language", "```\nx\n```", "<pre><code>x</code></pre>", "x"],
  ["unsafe language class is dropped", "```a\"b\nx\n```", "<pre><code>x</code></pre>", "x"],
  ["heading", "# Title", "<h1>Title</h1>", "Title"],
  ["blockquote", "> quoted", "<blockquote><p>quoted</p></blockquote>", "> quoted"],
  ["unordered list", "- a\n- b", "<ul><li>a</li><li>b</li></ul>", "- a\n- b"],
  ["ordered list keeps start", "3. c\n4. d", '<ol start="3"><li>c</li><li>d</li></ol>', "3. c\n4. d"],
  ["https link", "[site](https://example.org/a?b=1&c=2)", '<a href="https://example.org/a?b=1&amp;c=2">site</a>', "site (https://example.org/a?b=1&c=2)"],
  ["mailto link", "[mail](mailto:a@example.org)", '<a href="mailto:a@example.org">mail</a>', "mail (mailto:a@example.org)"],
  ["matrix.to pill link is https", "[x](https://matrix.to/#/@bob:example.org)", '<a href="https://matrix.to/#/@bob:example.org">x</a>', "x (https://matrix.to/#/@bob:example.org)"],
  ["table", "| a | b |\n|---|---|\n| 1 | 2 |", "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>", "a | b\n1 | 2"],
  // Injection and escaping
  ["raw script tag without markup stays plain text", "<script>alert(1)</script>", undefined, "<script>alert(1)</script>"],
  ["raw script tag next to markup is escaped", "**b** <script>alert(1)</script>", "<strong>b</strong> &lt;script&gt;alert(1)&lt;/script&gt;", "b <script>alert(1)</script>"],
  ["javascript link is dropped to its text", "[click](javascript:alert(1))", undefined, "click"],
  ["data link is dropped to its text", "[d](data:text/html,<b>x</b>)", undefined, "d"],
  ["whitespace-obfuscated javascript link is not a link", "[c](java\tscript:alert(1))", undefined, "[c](java\tscript:alert(1))"],
  ["autolink javascript is not linked", "<javascript:alert(1)>", undefined, "<javascript:alert(1)>"],
  ["quote and ampersand escaped", "a & \"b\" 'c'", undefined, "a & \"b\" 'c'"],
  ["escaped markdown stays literal", "\\*not em\\*", undefined, "*not em*"],
  ["snake case is not emphasis", "snake_case_name", undefined, "snake_case_name"],
  ["unclosed bold stays literal", "**open", undefined, "**open"],
  ["html inside bold is escaped", "**<img src=x onerror=1>**", "<strong>&lt;img src=x onerror=1&gt;</strong>", "<img src=x onerror=1>"],
];

for (const [name, md, html, body] of cases) {
  test(`markdown: ${name}`, () => {
    const out = toMatrixText(md);
    assert.equal(out.body, body);
    if (html === undefined) assert.equal(out.formattedBody, undefined, `unexpected html ${out.formattedBody}`);
    else assert.equal(out.formattedBody, html);
  });
}

test("markdown: formatted output never contains a disallowed tag", () => {
  const hostile = "<iframe src=x></iframe> <img src=x> [a](https://x.y) <span>s</span> *<u>u</u>*";
  const html = toMatrixText(hostile).formattedBody ?? "";
  const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
  const allowed = new Set(["strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "a", "br", "p", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "hr"]);
  for (const t of tags) assert.ok(allowed.has(t), `disallowed tag ${t}`);
});

test("safeHref allows only http(s) and mailto", () => {
  assert.equal(safeHref("https://example.org"), "https://example.org");
  assert.equal(safeHref("http://example.org/x"), "http://example.org/x");
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x", "/relative", "ftp://x.y", "https://user:pw@x.y", "https://x.y/a b", ""]) {
    assert.equal(safeHref(bad), undefined, bad);
  }
});
