import { fileURLToPath } from "node:url";
import { estimateTokens, htmlToMarkdown } from "../../packages/core/src/tools/web/html.ts";
import { exporterMain } from "./lib.mjs";

const base = "https://pages.fixture.invalid/edition/today";
const older = "A readable printed article contains several sentences on its own without loading a script.";
const corpus = [
  ["article", '<nav>navigation</nav><article><header><h1>One edition</h1></header><p>Text with <b>bold</b>, <em>emphasis</em>, and <code>a &lt; b</code>.</p><footer>footer</footer></article>'],
  ["nested-list", "<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol><li>first<li>second</ol>"],
  ["links", '<p><a href="/story">Read today</a> <a href="mailto:editor@fixture.invalid">Contact</a> <img src="cover.png" alt="Cover photo"> <a href="ftp://files.fixture.invalid/">Archive</a></p>'],
  ["code", '<pre><code class="language-rust">one\n  two\n</code></pre><blockquote><p>quoted words</p><p>next paragraph</p></blockquote><hr>'],
  ["data-table", '<table><caption>Counts</caption><thead><tr><th>Name<th>Items<th>Note</thead><tbody><tr><td rowspan="2">A<td colspan="2">one | two<tr><td>3<td>done</tbody></table>'],
  ["layout-table", '<table><tr><td><h1>Article table</h1><p>Readable text</p><td>Note</table>'],
  ["furniture", '<div class="has-sidebar"><main class="layout"><p>keep</p><div class="newsletter">newsletter</div></main><aside>noise</aside></div>'],
  ["conditional-fallback", `<main><p>New</p></main><p>${older}</p>`],
  ["attrs", '<p class="first" class="hidden" title="a>b">Keep one</p><p aria-hidden="true">Hide one</p><p style="display:none">Hide two</p>'],
  ["malformed-attrs", '<p title="unfinished><b>Read this<p>Read more</p>'],
  ["malformed-inline", "<p>First<p>Second<b>bold</i>after<h2>Heading</h2><p>Tail"],
  ["definition-list", "<dl><dt>Name<dd>Value<dt>Another<dd>Difference</dl>"],
  ["unicode-entities", '<p>“Title” &mdash; 世界 &#x1f30d; &lt;code&gt; &#160; &unknown;</p><!-- hidden -->'],
  ["metadata", '<html lang="de"><head><title> Hallo &amp; Welt </title><link href="../canonical" rel="alternate Canonical"><meta property="article:published_time" content="2026-11-23T12:30:00Z"></head><body><p>STRENGTH</p></body></html>'],
  ["metadata-clip", `<html lang="${"a".repeat(38)}"><title>${"a".repeat(298)}🌙 final</title><time datetime="2026-11-23">Monday</time></html>`],
  ["password-evidence", '<h1>Sign in</h1><form><input type="password"></form>'],
  ["hidden-password", '<p>Public preview</p><form hidden><input type="password"></form>'],
  ["paywall-evidence", '<main><p class="subscriber-only">Subscriber preview</p></main>'],
  ["verification-evidence", '<title>Confirm that you are a person</title><h1>Continue</h1>'],
  ["scripted-shell", '<div id="__next"></div><script src="/app.js"></script>'],
  ["scripted-fallback", `<div id="app"></div><script src="/app.js"></script><noscript><p>${older}</p></noscript>`],
  ["scripted-notice", '<script src="/app.js"></script><noscript>Please enable JavaScript to view this site and read its articles and photos.</noscript>'],
  ["unicode-short-article", '<script src="/stats.js"></script><p>这是一篇简短而真实的文章，读者可以在此阅读原文和简要信息。</p>'],
] as const;

export function recordWebHtml() {
  const blankLines = [5000, 20000].map((lines) => {
    const words = 79500;
    const input = `<p>${"word word ".repeat(words)}</p><pre>x${"\n".repeat(lines)}y</pre>`;
    const { markdown } = htmlToMarkdown(input, base);
    return { words, lines, base, tokens: estimateTokens(markdown), suffix: markdown.slice(-14) };
  });
  return { html: {
    source: "packages/core/src/tools/web/html.ts",
    cases: corpus.map(([name, input]) => ({
      name, input, base, expected: htmlToMarkdown(input, base),
    })),
    blankLines,
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "web", build: recordWebHtml });
}
