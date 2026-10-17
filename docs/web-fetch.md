# `web.fetch` — extraction, typed failures, the golden corpus and the SSRF suite

Hand-written. Code: `packages/core/src/tools/web/` (`fetch.ts`, `http.ts`, `guard.ts`, `ip.ts`, `html.ts`, `failure.ts`,
`robots.ts`, `tools.ts`). Decision: D94 in `docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md`. Egress policy in
front of it: `docs/egress.md`. Milestone: M2 acceptance 12 (`docs/milestones.md`).

`web.fetch { url, mode?, section?, cursor?, maxTokens?, crawl? }` reads one http(s) page or text document and returns
readable Markdown with a table of contents, metadata and a provenance envelope (`source: "web"`, `trust: "untrusted"`):
page text is data, never instructions.

## What it does today

| Step | Behaviour |
|---|---|
| Fetch | One guarded client for every hop: address guard on the first request and each redirect (max 10), connect pinned to the vetted address, one deadline, a 20 MB cap on **decompressed** bytes, gzip / deflate / brotli, no cookies and no caller headers |
| Classify | HTML, JSON, XML, plain text, Markdown and CSV are read. A missing or "any bytes" content type (`application/octet-stream`) is decided by the body: an HTML document is read as HTML, anything else is `unsupported-type`. A binary file is recognised by its magic number whatever the label says (PDF, ZIP and Office, PNG, GIF, JPEG, gzip, ELF). `text/plain` that is plainly an HTML document is read as HTML (`mode: "raw"` never reinterprets) |
| Charset | Header, then BOM, then `<meta>`, then a sniff: valid UTF-8, otherwise windows-1252. A charset the decoder does not know falls through to the next step |
| Extract | Main content (`<main>`, a single `<article>`, else the body) to Markdown: headings, lists, tables, code, links as absolute URLs, image alt text. Dropped: scripts, navigation, headers and footers, forms, hidden elements, consent banners, and elements whose class or id names page furniture (sidebar, share bar, pager, related stories, in-page contents, "[edit]" links, footers). An element that wraps the content is never dropped by its class |
| Tables | Column and row spans are expanded into empty cells so every value stays under its own header; a caption becomes the line above the table; a layout table (cells holding headings or tables) is read as ordinary blocks |
| Broken HTML | Forgiving tokenizer: implied end tags (unclosed paragraphs, list items, cells, headings and inline formatting do not swallow what follows), an unterminated attribute quote ends at the tag's own bracket, a node and depth cap |
| Walls | A page that is only a wall is reported as one, with evidence from the page: a CAPTCHA widget or challenge text on a short page is `captcha` (also on 403 / 429 / 503 answers, whose bodies are read up to 128 KB for this), a short page with a password field is `auth-required`, a short page with a visible paywall prompt is `paywall`. A long article that merely embeds a CAPTCHA widget, a login box or hidden paywall markup is returned |
| Sections | Split at headings. `sections[]` lists at most 200 entries; when there are more, `sectionsTotal` says how many (ids beyond the list stay valid). Chunks end at a paragraph, line or word boundary and `cursor` continues; nothing is truncated silently, a document above the extracted-token cap (200 000) fails loudly with `too-large` |
| Client-rendered shells | An empty application root (or next to no text beside a loaded bundle) is `needs-render`, never an empty success. A shell that ships its content in `<noscript>` yields that content |

### Typed failures

Every failure carries `code`, `hint` (for the agent) and `userAction` (one sentence for the person). The codes `web.fetch`
produces are: `invalid-arguments`, `invalid-url`, `private-address`, `egress-denied`, `not-found`, `gone`, `auth-required`,
`paywall`, `captcha`, `rate-limited` (with `retryAfterSeconds`), `timeout`, `too-large`, `unsupported-type`, `tls-error`,
`needs-render`, `too-many-redirects`, `robots-disallowed`, `network-error`, `http-error`, `cursor-expired`,
`internal-error`. `no-provider` and `provider-failed` belong to `web.search` (D95). A CAPTCHA is never solved.

### Known gaps (what the corpus records as typed failures instead of text)

- **PDF, scanned PDF (OCR), DOCX and other Office files** are `unsupported-type`. D94 wants `pdf.js` and MarkItDown; neither
  is a dependency of the core, and OCR needs a further one. The fixtures `unsupported-pdf-text`, `unsupported-pdf-scanned`,
  `unsupported-docx` and `unsupported-xlsx` pin today's behaviour and become extraction goldens when the owner decides on
  the dependencies.
- **The headless render fallback** (`renderUsed: true`, `mode: "render"`) needs the D74 browser and is not built; the
  honest answer is `needs-render`.
- **`question`, conditional requests (`ETag` / `Last-Modified`) and the per-harness response cache** are not built.
- 403 answers without any sign-in form or CAPTCHA are still `auth-required` (D94 says "401/403 with a login form
  detected"); only the 401 and the form-bearing cases are certain.

## The golden corpus (M2 acceptance 12)

`packages/core/test/fixtures/web-fetch/` holds the corpus; `packages/core/test/tools/web/corpus/` holds the gate.

```
fixtures/web-fetch/
  corpus.json            the manifest: id, category, how the offline server answers, what is expected
  pages/<id>.<ext>       the served bodies (hand-written HTML, a few legacy-charset byte files)
  goldens/<id>.md        expected Markdown of a page      goldens/<id>.json   expected typed failure, or the
                                                                               recorded SHA-256 of a generated golden
test/tools/web/corpus/
  corpus.test.ts         the gate: every fixture through the production web.fetch
  ssrf-suite.test.ts     the SSRF suite
  server.ts              the offline fixture server (loopback only)
  generators.ts          deterministic generators for what is too big or too binary to check in
  metrics.ts             token recall, heading and table checks
```

All content is synthetic and self-written; no page is copied. The 500-page manual, the 380 000-character line, the gzip
bomb, the PDFs (text and scanned), the DOCX / XLSX and the PNG are generated by `generators.ts` at test time. Their
goldens are recorded as SHA-256 values, so a drifting generator fails the gate.

### Gate

For every extraction fixture the test serves the page from the offline server, calls the production `createWebFetch`, walks
the cursor to the end and requires, against the golden:

1. at least **95 %** of the golden's main-text tokens (multiset recall over Unicode word segments; Markdown syntax and link
   targets are not tokens);
2. **every heading**, with its level and in order;
3. **every table**, with the same rows and cells;
4. every link target of the golden, absolute;
5. none of the boilerplate strings the fixture names (`mustNotContain`), no U+FFFD unless the golden has one;
6. plain-text kinds (text, Markdown, JSON, XML, CSV) come back exactly as written (JSON pretty-printed);
7. the provenance envelope and the final URL after redirects.

Failure fixtures (`goldens/<id>.json`) require the exact typed code, the status and `retryAfterSeconds` where recorded, and a
`hint` and `userAction`. A final test lists the failure enum (`WEB_FAILURE_CODES`) and requires every code that the `web.fetch` code path names
(found by scanning its sources, so codes that only `web.search` throws are not required) to be produced by at least one
fixture **and** declared by a golden. The generated entries check that the cursor
walk reproduces the whole document (500 pages, 525 headings, 25 chapters) and that a section jump returns one page with its
table. The gate's own metrics are tested too: dropping more than 5 % of the tokens, a lost heading or a changed heading
level and a damaged table each fail it.

Thresholds and goldens are never relaxed to make a fixture pass: when a fixture failed, `web.fetch` was fixed. The corpus
found, among others: short pages and CJK pages with an analytics script reported as `needs-render`; unclosed headings and
bold text swallowing the rest of a page; an unterminated attribute quote swallowing the rest of a page; sidebars, share
bars and pagers leaking into the text; spans misaligning table columns and captions being lost; a layout table collapsing a
page into one row; undeclared Latin-1 decoding to replacement characters; HTML served as `text/plain` or
`application/octet-stream` and PDFs served as `text/html`; CAPTCHA, sign-in and paywall pages reported as `needs-render`,
`rate-limited` or returned as articles; a table of contents that silently listed only 200 of 525 sections; chunks that cut
words in two; unexpected exceptions traced as `network-error`.

### Running it

The corpus runs offline in the normal core suite (`pnpm --filter @plur1bus/core test`). Alone:

```
cd packages/core
node --experimental-strip-types --no-warnings=ExperimentalWarning --test test/tools/web/corpus/*.test.ts
```

`tls-error` is produced by an https fixture with a self-signed certificate made with `openssl`; on a machine without
`openssl` that one fixture skips itself (the same precedent as `http.test.ts`) and the enum coverage test tolerates exactly
that one code.

The quality bar also names a nightly live run over 20 real URLs that reports drift without gating. It needs the network and is
not part of this change (KNOWN GAP).

### Adding a fixture

Write the page into `pages/`, its golden into `goldens/` (use `{{BASE}}` for the fixture server's origin in absolute links)
and an entry into `corpus.json`. Write the expectation as a person would want the page read, not as the extractor happens
to print it; if the extractor disagrees, that is a finding.

## The SSRF suite

`ssrf-suite.test.ts` drives the production `createWebFetch` (with the B4 egress gate where relevant) against a loopback
server whose hit counter proves a refused destination was never contacted. Covered: private (RFC 1918, shared address
space, ULA), loopback and every spelling of it (decimal, octal, hex, short forms, trailing dot, full-width and
ideographic-dot characters, `localhost` and `*.localhost`), link-local, the metadata endpoints of the large clouds (AWS and
GCP `169.254.169.254`, the AWS IPv6 endpoint, Alibaba `100.100.100.200`, Oracle `192.0.0.192`, Azure `168.63.129.16`),
multicast, broadcast and reserved ranges, IPv4-mapped IPv6 (dotted and hex, upper case, long form), IPv4-compatible, NAT64,
6to4 and IPv4-translated forms; names resolving to any of these, alone or mixed with public answers; DNS rebinding (the
answer used for the connection is the answer that was checked, one resolution per hop, a second resolution of the same name
on a redirect hop is checked again); redirects from a permitted first hop to each of the above, to non-http schemes and to
URLs with credentials, also on a later hop and protocol-relative; no cookies, credentials or referrer on any hop; an
allowlist entry is an exact range; the egress gate refusing before name resolution and `robots.txt` going through the same
guard.
