import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToHtml } from "../src/markdown.ts";
import { htmlToText } from "../src/html-text.ts";
import { buildMessage, encodeWords, sanitizeFilename, assertHeaderValue } from "../src/mime-build.ts";
import { parseMessage, decodeEncodedWords } from "../src/mime-parse.ts";

const MD: [string, string, string][] = [
  ["plain", "hello world", "<p>hello world</p>"],
  ["bold", "a **b** c", "<p>a <strong>b</strong> c</p>"],
  ["bold underscore", "a __b__ c", "<p>a <strong>b</strong> c</p>"],
  ["italic", "a *b* c", "<p>a <em>b</em> c</p>"],
  ["italic underscore", "a _b_ c", "<p>a <em>b</em> c</p>"],
  ["snake_case is not emphasis", "use snake_case_name here", "<p>use snake_case_name here</p>"],
  ["inline code escapes", "run `a<b>&c`", "<p>run <code>a&lt;b&gt;&amp;c</code></p>"],
  ["code span keeps markup", "`**not bold**`", "<p><code>**not bold**</code></p>"],
  ["fenced block", "```\nlet a = 1 < 2;\n```", "<pre><code>let a = 1 &lt; 2;</code></pre>"],
  ["fence with markup inside", "```\n<script>x</script>\n```", "<pre><code>&lt;script&gt;x&lt;/script&gt;</code></pre>"],
  ["unclosed fence runs to end", "```\nabc", "<pre><code>abc</code></pre>"],
  ["link http", "[site](https://example.test/a?b=1&c=2)", '<p><a href="https://example.test/a?b=1&amp;c=2">site</a></p>'],
  ["link mailto", "[mail](mailto:a@example.test)", '<p><a href="mailto:a@example.test">mail</a></p>'],
  ["javascript link is text", "[x](javascript:alert(1))", "<p>[x](javascript:alert(1))</p>"],
  ["data link is text", "[x](data:text/html,hi)", "<p>[x](data:text/html,hi)</p>"],
  ["html is escaped", "<img src=x onerror=alert(1)>", "<p>&lt;img src=x onerror=alert(1)&gt;</p>"],
  ["quote quotes", '"q" \'s\'', "<p>&quot;q&quot; &#39;s&#39;</p>"],
  ["unordered list", "- one\n- two", "<ul><li>one</li><li>two</li></ul>"],
  ["ordered list", "1. one\n2) two", "<ol><li>one</li><li>two</li></ol>"],
  ["blockquote", "> quoted\n> more", "<blockquote><p>quoted<br>\nmore</p></blockquote>"],
  ["heading becomes strong", "# Title", "<p><strong>Title</strong></p>"],
  ["paragraphs by blank line", "a\n\nb", "<p>a</p>\n<p>b</p>"],
  ["hard line break", "a\nb", "<p>a<br>\nb</p>"],
  ["bold inside link label", "[**x**](https://a.test)", '<p><a href="https://a.test"><strong>x</strong></a></p>'],
  ["emphasis cannot rewrite href", "[x](https://a.test/*a*)", '<p><a href="https://a.test/*a*">x</a></p>'],
];
for (const [name, input, want] of MD) {
  test(`markdown: ${name}`, () => {
    assert.equal(markdownToHtml(input), want);
  });
}

test("markdown output contains only allowlisted tags", () => {
  const out = markdownToHtml("# h\n\n**b** *i* `c` [l](https://x.test)\n\n- a\n\n> q\n\n```\nz\n```\n\n<b>raw</b>");
  const tags = new Set([...out.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase()));
  for (const t of tags) assert.ok(["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "a"].includes(t), t);
});

const HTML: [string, string, string][] = [
  ["script and style removed", "<style>p{}</style><script>alert(1)</script>Hi", "Hi"],
  ["blocks become paragraph breaks", "<div>a</div><p>b</p>", "a\n\nb"],
  ["br", "a<br>b", "a\nb"],
  ["link with text", '<a href="https://a.test">site</a>', "site (https://a.test)"],
  ["link text equals url", '<a href="https://a.test">https://a.test</a>', "https://a.test"],
  ["javascript link keeps text only", '<a href="javascript:x()">click</a>', "click"],
  ["mailto link", '<a href="mailto:a@b.test">a@b.test</a>', "a@b.test"],
  ["entities", "&amp; &lt;x&gt; &quot;q&quot; &#65; &#x42; &euro;", '& <x> "q" A B €'],
  ["bogus entity kept", "&notanentity; ok", "&notanentity; ok"],
  ["invalid numeric entity dropped", "a&#xD800;b", "ab"],
  ["comment removed", "a<!-- secret -->b", "ab"],
  ["list items", "<ul><li>one</li><li>two</li></ul>", "- one\n- two"],
  ["unclosed script removed to end", "x<script>alert(1)", "x"],
];
for (const [name, input, want] of HTML) {
  test(`html-to-text: ${name}`, () => {
    assert.equal(htmlToText(input), want);
  });
}

test("encodeWords: ASCII untouched, non-ASCII round-trips, long text split on code points", () => {
  assert.equal(encodeWords("plain subject"), "plain subject");
  for (const s of ["Grüße aus Köln", "日本語のテキスト", "emoji 🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂"]) {
    const enc = encodeWords(s);
    assert.ok(enc.startsWith("=?UTF-8?B?"));
    assert.equal(decodeEncodedWords(enc), s);
  }
});

test("header values with CR, LF or NUL are refused (header injection)", () => {
  for (const v of ["x\r\nBcc: evil@x.test", "x\ny", "x\0y", "x\ry"]) {
    assert.throws(() => assertHeaderValue("Subject", v), /control characters/);
    assert.throws(() => encodeWords(v));
  }
  assert.throws(() =>
    buildMessage({
      from: { address: "bot@example.test" },
      to: "a@example.test",
      subject: "s\r\nBcc: x@y.test",
      text: "t",
      messageId: "m@example.test",
      date: 0,
    }),
  );
  assert.throws(() =>
    buildMessage({
      from: { address: "bot@example.test" },
      to: "a@example.test\r\nBcc: x@y.test",
      subject: "s",
      text: "t",
      messageId: "m@example.test",
      date: 0,
    }),
  );
  assert.throws(() =>
    buildMessage({
      from: { address: "bot@example.test" },
      to: "a@example.test",
      subject: "s",
      text: "t",
      messageId: "m@example.test",
      date: 0,
      inReplyTo: "x>\r\nBcc: y",
    }),
  );
});

const FILE_NAMES: [string | undefined, string][] = [
  ["report.pdf", "report.pdf"],
  ["../../etc/passwd", "passwd"],
  ["C:\\Users\\x\\a.png", "a.png"],
  ["..hidden", "hidden"],
  ["ümlaut name (1).png", "_mlaut_name_1_.png"],
  [undefined, "attachment"],
  ["   ", "attachment"],
];
for (const [input, want] of FILE_NAMES) {
  test(`sanitizeFilename: ${String(input)}`, () => {
    const got = sanitizeFilename(input);
    assert.equal(got, want);
    assert.match(got, /^[A-Za-z0-9._-]{1,100}$/);
  });
}

test("built message parses back: plain, html alternative, attachment, Auto-Submitted, threading headers", () => {
  const raw = buildMessage({
    from: { name: "Bot Ünïcode", address: "bot@example.test" },
    to: "alice@example.test",
    subject: "Re: Grüße",
    text: "Hallo **Welt**",
    html: markdownToHtml("Hallo **Welt**"),
    messageId: "abc@example.test",
    date: Date.UTC(2026, 9, 8, 10, 0, 0),
    inReplyTo: "parent@example.test",
    references: ["root@example.test", "parent@example.test"],
    attachments: [{ filename: "../pic.png", mimeType: "image/png", data: Buffer.from([1, 2, 3, 4]) }],
    boundary: (() => {
      let i = 0;
      return () => `bnd${i++}`;
    })(),
  });
  const m = parseMessage(raw);
  assert.equal(m.subject, "Re: Grüße");
  assert.equal(m.from?.address, "bot@example.test");
  assert.equal(m.from?.name, "Bot Ünïcode");
  assert.equal(m.messageId, "abc@example.test");
  assert.equal(m.inReplyTo, "parent@example.test");
  assert.deepEqual(m.references, ["root@example.test", "parent@example.test"]);
  assert.equal(m.headers.get("auto-submitted"), "auto-replied");
  assert.equal(m.headers.get("precedence"), undefined);
  assert.equal(m.text, "Hallo **Welt**");
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0]!.filename, "pic.png");
  assert.deepEqual([...m.attachments[0]!.data], [1, 2, 3, 4]);
});

test("built text-only message round-trips without attachments", () => {
  const raw = buildMessage({
    from: { address: "bot@example.test" },
    to: "alice@example.test",
    subject: "Hi",
    text: "line one\nline two",
    messageId: "x@example.test",
    date: 0,
  });
  const m = parseMessage(raw);
  assert.equal(m.text, "line one\nline two");
  assert.equal(m.attachments.length, 0);
});
