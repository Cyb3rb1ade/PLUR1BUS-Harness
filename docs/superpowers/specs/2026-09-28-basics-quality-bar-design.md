# The basics everyone expects: a quality bar — design

**Status:** Draft rev 2 for owner review (rev 2, same day: owner feedback — D94 failure hints and the CAPTCHA question, D98 file names, new D103 capability index with category routing, new D104 hand-off format; rev 3: new D105 message triage; rev 4: new D106 host toolset; rev 5: new D107 OS ecosystem layer; rev 6: new D108 remote desktop control by the person's own harness; rev 7, 2026-09-30: new D109 permission and approval model) · **Date:** 2026-09-28 · **Owner:** Christian (Cyb3rb1ade) · **Decision rows:** core spec D94–D109 (`2026-09-24-m1b-2a-core-daemon-cli-design.md` §2) · **Milestones:** additions to M1b-2b, M2, M5, M6, M8, track D (D1, D3) and §6.1 (`docs/milestones.md`) · **Amends:** D49 (skill mining), D65 (PDF skill: creating designed documents moves to D100), D75 (SearXNG becomes one `web.search` provider); D109 refines D38, D104, D106, D107, D108 and resolves D62's credential-entry wording · **Inputs:** ADR-003 (collaboration, typed delegation contract), ADR-010 (cache rules R1–R8), core spec D21, D36, D47, D54, D57, D58, D64, D69, D72–D76, desktop spec §4.6, §6.5, DS30–DS39, desktop D1 plan DR4

**Owner requirements, 2026-09-28 (translated from German, condensed):**

1. "We must make sure the total basics that everyone expects work properly": coding standards and documentation standards are kept when someone codes with PLUR1BUS in a project.
2. "Tool use must work perfectly."
3. The skill miner must also look at **every finished task**, not only later across all memories (the long-term pass stays — "it discovers long-term patterns, which is fairly unique on the market right now"), and may propose a skill **after one or two successful completions** of such a task. The proposal must be acceptable **through the agent** — "ideally proposed like a critical push, asking whether to adopt it as a skill."
4. "Web fetch must work perfectly. Web fetch is among the most important things." Scrolling on the internet must work "without big restrictions"; the agent gets the tools it needs.
5. After installation, the **Windows installer asks** for a desktop icon, a Start-menu entry and start with Windows — **all three ticked by default, opt-out**. On macOS and Linux the app also lands in autostart.
6. A PDF report or an essay produced by an agent must not look "typed on an 80s typewriter": it must look "like a 100,000-euro-per-job advertising agency" — modern, glossy, high contrast, high quality.
7. Question: does an emergent agent-to-agent language (the owner remembered a paper/video where agents switched to an efficient non-human "beeping" language) make sense as the communication layer between agents?

8. (Feedback on rev 1.) Fallbacks and "knowing what works and what doesn't" approved; error messages must be reflected back properly, **with a suggested fix for the person**; "simple CAPTCHAs he could theoretically solve".
9. Why `CLAUDE.md`?
10. A **nightly routine that writes all skills (once at the start, then the new ones) into a database** in a short, fast-to-read form, **sorted into categories**, so that the decision model (Jev, Laya) looks at a task and tells the agent "70 % you need tools from category range 130–160, 30 % from 1–30" — a quick pre-selection so the agent finds its tool more reliably.
11. Installer and design system approved as proposed; agent language dropped, but **a fixed hand-off format is wanted — "you are an agent yourself and know exactly what you need when accepting and handing over work"**.

12. (Rev 3.) Since the decision model already analyses the prompt, it should also say **whether a message holds one task or several**, and **recommend a small, medium or large model per task** — knowing the classes of each provider (e.g. Claude Haiku, Sonnet, Opus, Fable) so it can say "this needs a Haiku-class model with x % probability, that one a Fable-class model"; "it makes all these decisions super fast, so we should use it".

The owner asked for this spec ("Ja") after the controller's summary of the gaps, and approved D94–D101 on rev 1 with the changes above. Nothing here is implemented.

## 1. Verified current state

Read 2026-09-28 on `origin/main` @ `049b9a3`.

| # | Fact | Evidence |
|---|---|---|
| F1 | **No web-fetch tool is specified anywhere.** Web access today is: the `browser` skill over CDP (D74, desktop spec §6.5, D3), WebMCP (D55), the Chrome extension (D37), and the vendored **SearXNG search skill** (D75, bundled/remote/off). | `grep -rniE "web_?fetch\|web\.fetch" docs` → no hit |
| F2 | The `browser` skill "teaches agents how to use it (navigate, read the accessibility tree before clicking, forms, downloads with approval, …)" and hands over at a login or CAPTCHA; there is **no fixed tool list** (scroll, extract, wait) and no statement how infinite scroll or virtualised lists are read. | core spec D74; desktop spec §6.5 |
| F3 | Tool calls are tested by **one** fixture turn per wire format (M2 acceptance 3). There is no tool-call validation, repair, or reliability eval in any spec. | `milestones.md` §M2 |
| F4 | **No coding or documentation standard is specified** for work agents do in a user's project. What exists: vendored superpowers (TDD, verification-before-completion, code review; D64), `git-ci-cd` and `api-interface-design` skills (D76), per-agent git worktrees in M5. | `grep -rniE "coding standard\|documentation standard" docs` → no hit; D64, D76; `milestones.md` §M5 |
| F5 | D49 mines **once per finished task** (explicit done only: `/done`, `task done`, `task.complete`, card → Done), background job `skill-mine`, idempotent per task id; proposals via the engine's proposal store, accepted by the human in CLI `skill proposals`, chat `/skills`, GUI card later. The engine's long-term `skill-miner` job (over the whole memory) also exists. **No repetition threshold and no in-conversation proposal.** | core spec D49; engine job names in the M1a plan (`"skill-miner"`); `lib/jobs/skill-miner/proposal-writer.js` |
| F6 | The engine has a **critical-push** mechanism with its own config node (`criticalPush`, `x-sensitive` api key); the canvas inbox `V2Inbox` lists "approvals, memory proposals, criticals, skill proposals" in one list. | E5 plan (`criticalPush.apiKey`); desktop spec §13 `V2Inbox` |
| F7 | Document creation today: D65 `pdf` skill **creates PDFs with `pdf-lib`** (a drawing API: positioned text and shapes — the "typewriter" risk the owner describes), D58 office → Markdown (read side only). The `web-design-guidelines` and `frontend-gui-webdesign` skills (D76) are about web UI, not documents. No design system for documents exists. | core spec D58, D65, D76 |
| F8 | Autostart: "Autostart at login (on by default for a bundled harness, a visible toggle)" in **D1**, LaunchAgent on macOS via `tauri-plugin-autostart`; the app starts minimised to the tray. Windows ships **NSIS** (`installMode: "currentUser"`, direct channel) and **MSIX** (Store); Linux `.deb`, `.rpm`, AppImage, **Flatpak**. No installer page, desktop icon or Start-menu choice is specified. | desktop spec §4.6, §6 table row "Autostart", DS30–DS34; D1 plan DR4 |
| F9 | Tauri's default NSIS template **creates the Start-menu shortcut unconditionally** and offers a desktop shortcut as a **finish-page checkbox** (`MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut`); the template is replaceable (`bundle.windows.nsis.template`) and hookable (`installerHooks`: `NSIS_HOOK_PREINSTALL`, `…POSTINSTALL`, `…PREUNINSTALL`, `…POSTUNINSTALL`). | [tauri `installer.nsi`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi); [Tauri Windows installer docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/distribute/windows-installer.mdx) |
| F10 | MSIX has no installer pages. A packaged desktop app's `StartupTask` with `Enabled="true"` is active after install without a first launch; "the user is in control and can change the enabled state … via the Startup page in Settings or the Startup tab in Task Manager", and a user-disabled task cannot be re-enabled by the app. Desktop shortcuts from MSIX exist through the `desktop7:Shortcut` extension. | [StartupTask class](https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.startuptask); [Advanced Installer: native desktop shortcuts in MSIX](https://www.advancedinstaller.com/create-native-desktop-shortcuts-in-msix-packages.html) |
| F11 | Flatpak apps request autostart through the **Background portal** `RequestBackground` (`reason`, `autostart`, `commandline`, `dbus-activatable`); the response says whether autostart was granted. | [xdg-desktop-portal: Background](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Background.html) |
| F12 | ADR-010 R4: toggling web-search/citations flags mid-session is a silent cache killer. | ADR-010 §1 R4 |
| F13 | The next free decision number is **D94**. | `grep -rhoE '\bD9[0-9]\b' docs` → highest D93 |

## 2. Decisions

### D94 — `web.fetch`: a first-class, harness-native tool

Every agent has `web.fetch` unless denied (behaviour-profile `tools.deny`, ADR-003). It is harness code, not a skill: the agent must not need instructions to read a web page.

**Call.** `web.fetch { url, mode?: "auto"|"markdown"|"raw"|"render", section?: string, cursor?: string, maxTokens?: number (default 6 000), question?: string }`.

**Pipeline (mode `auto`).**
1. **Fetch** over the agent's egress profile (D73): HTTP/1.1 and 2, redirects (max 10, each hop re-checked by the SSRF guard), compression, charset detection (header → BOM → `<meta>` → sniff), conditional requests (`ETag`/`Last-Modified`) against a per-harness cache (default 15 min, `Cache-Control` honoured, private responses cached per agent only).
2. **Classify** the content type: HTML → step 3; PDF → text and layout via `pdf.js` (D65), OCR offered for scanned PDFs; Office files → MarkItDown (D58); JSON/XML/CSV/plain text → returned as-is, pretty-printed; images → passed to a vision-capable model if the agent has one, else metadata only; anything else → `unsupported-type`.
3. **Extract** HTML: Mozilla Readability (Apache-2.0) for the main content, then HTML → Markdown (Turndown, MIT) keeping headings, lists, tables, code blocks, links (as absolute URLs) and image alt text; boilerplate (nav, cookie banners, footers) dropped; `<title>`, canonical URL, publication date and language kept as metadata.
4. **Render fallback.** If extraction yields almost nothing (text under a threshold, or known client-rendered markers such as an empty root `<div>` with a script bundle), the page is loaded in a **headless browser** — the D74/D3 browser container, or the native panel's engine when the desktop app is attached — waiting for network idle (cap 15 s), and step 3 runs on the rendered DOM. The result says `renderUsed: true`. Without any browser available the tool returns `needs-render` with that reason, never an empty success.
5. **Sections, never silent truncation.** Long documents are split at headings into sections; the result carries a table of contents (`sections[]` with ids and token sizes), the first chunk up to `maxTokens`, and a `cursor` for the next chunk. `section` jumps to one section. `question` asks the harness to return the sections most relevant to the question first (our own embedder, D54) — the full document stays reachable by cursor.

**Result.** `{ finalUrl, status, contentType, title, lang, publishedAt?, markdown, sections[], cursor?, renderUsed, fromCache, fetchedAt }`, delivered as a `tool_result` with a **provenance envelope** (`source: web`, URL, fetch time) — web content is untrusted data, never instructions (the same rule as M5 peer output).

**Typed failures** (the agent always learns *why*): `not-found`, `gone`, `auth-required` (401/403 with a login form detected), `paywall`, `captcha`, `rate-limited` (with `Retry-After`), `timeout`, `too-large` (default cap 20 MB download, 200 k tokens extracted), `unsupported-type`, `tls-error`, `egress-denied`, `private-address`, `needs-render`. On `auth-required` or `captcha` the agent may offer the person a **handover** in the browser panel (desktop spec §6.5); it never solves CAPTCHAs and never types passwords.

**Every failure carries two texts** (rev 2, owner item 8): `hint` for the agent (what to try next: another source via `web.search`, the `render` mode, a later retry at `Retry-After`, a narrower `section`) and `userAction`, one sentence the agent can pass on as a concrete suggestion for the person — e.g. *"The page needs a login: sign in in the browser panel and say 'continue'"*, *"Paywalled: forward me the article or give me access; meanwhile I found two free sources"*, *"The site limits automated requests; I will retry at 14:05"*. The agent reports a failure with the `userAction` instead of a bare error, and tries the `hint` first where it is safe to.

**CAPTCHAs are not solved, including simple ones** (owner item 8, answered): a CAPTCHA is the site's explicit check that a human is present; solving it for the person turns PLUR1BUS into a bot-detection bypass, breaks the sites' terms, and would put the Store and Flathub listings and the project's trust at risk. What reduces CAPTCHAs legitimately is done instead: pages go through the **native panel with the person's own browser profile** where the desktop app is attached (their cookies and logins, a real browser — the most common reason for a CAPTCHA disappears); pacing per host; official APIs, feeds and exports preferred over scraping; other sources through `web.search`. When one still appears and the person is present, the handover takes seconds; when they are away, the task parks with a notification carrying the `userAction`, and the rest of the task continues where it can.

**Safety.**
- **SSRF guard:** loopback, link-local, private (RFC 1918, ULA) and cloud-metadata addresses are refused as `private-address`, after DNS resolution and on every redirect hop; exceptions are an explicit per-installation allowlist (typical: the owner's Tailscale names and `100.x` addresses, D72).
- **Robots:** a fetch the person or the agent's current task asks for is a user agent acting for a person and does not consult `robots.txt`; any **crawl** (following links beyond the page asked for, more than 20 pages per task on one host) honours `robots.txt` and a per-host rate limit (default 1 request/s).
- **User agent:** an honest one (`PLUR1BUS/<version> (+https://plur1bus.app/bot)`), never a browser imitation in the plain fetch path; the render path is a real browser and identifies as one.
- Response bodies and fetched content never go into logs; the trace records URL, status, sizes and timing.

**Quality gate (M2).** A fixture corpus of at least 60 recorded pages — news article, blog, docs site, GitHub README and issue, Wikipedia, a client-rendered SPA, a PDF, a scanned PDF, a DOCX, a JSON API, a 500-page manual, a page in German and one in Japanese, a paywall, a 404, a redirect chain, a cookie wall — with a golden Markdown per page; extraction must keep ≥ 95 % of the golden's main-text tokens and every heading and table; plus a nightly live run over 20 real URLs that reports (does not gate) drift.

### D95 — `web.search`: one tool, pluggable providers

`web.search { query, count?: number (default 8, max 20), freshness?: "day"|"week"|"month"|"year", site?: string, lang?: string }` → `{ results: [{ title, url, snippet, publishedAt?, source }], provider }`, normalised across providers.

- **Providers:** **SearXNG** (D75, bundled/remote/off — the owner's own instance over Tailscale is the expected default), **Brave Search API**, **Tavily**, **Exa** (API keys in the secret store), and the model provider's **native search tool** where the agent's model offers one.
- **Choice per agent, not per turn:** the provider is an agent setting; switching the native search tool on or off is a cache-affecting change (ADR-010 R4), so it happens between sessions, never mid-session.
- **Fallback order** is configurable; a failing provider is skipped with a trace note, and the result names the provider used.
- **No provider configured:** setup offers the bundled SearXNG; until then `web.search` returns `no-provider` with a one-line fix, and the agent still has `web.fetch`.
- D75's vendored skill stays as usage guidance (query syntax, engines) for SearXNG; the call path is `web.search`.

### D96 — Browser tools with a fixed contract, including scrolling

The `browser` skill (D74) keeps the *how*; the *what* becomes a fixed tool set that works identically against the native panel (WebView2 on Windows, CEF on macOS/Linux; D3, DS37) and the windowless browser container, over CDP behind the token proxy:

| Tool | Behaviour |
|---|---|
| `browser.navigate { url }` | Same SSRF guard and egress profile as D94. |
| `browser.read { cursor? }` | The page as an accessibility-tree outline plus visible text, element refs for interaction, paginated by cursor. |
| `browser.screenshot { fullPage? }` | For vision-capable models. |
| `browser.find { text \| role \| selector }` | Returns element refs. |
| `browser.click / type / press / select / hover { ref, … }` | Scroll the element into view first; report what changed (navigation, dialog, new content). |
| `browser.scroll { direction?: "down"\|"up", amount?: "page"\|px, to?: ref \| "bottom" \| "top", untilStable?: boolean }` | `untilStable` scrolls, waits for network idle and DOM growth, repeats until nothing new appears or a cap (default 20 steps, 60 s), and returns **only the new content** since the last read, de-duplicated — this is how infinite feeds and virtualised lists are read. Scrollable inner containers are addressed by `ref`. |
| `browser.wait { for: ref \| "network-idle" \| text, timeoutMs }` | |
| `browser.extract { schema, scope? }` | Structured extraction into a JSON schema from the current page (tables, lists, product data). |
| `browser.tabs.list / open / select / close` | |
| `browser.download { ref }` | Always with approval (existing D74 rule). |
| `browser.handover { reason }` | Pauses the agent and gives the panel to the person (login, CAPTCHA, payment); resumes on the person's *Done*. |

- **Cookie and consent banners:** the most privacy-preserving choice ("reject non-essential") is clicked by default; a person can change the default.
- **Limits that stay:** no CAPTCHA solving, no password entry, no purchases or form submissions without the approval rules the harness already has; these are the only "restrictions", and each surfaces as a clear handover, not a silent failure.
- An engine that cannot do a needed CDP method reports it in `browser` capabilities (desktop spec §4.23 rule), never emulates silently.

### D97 — Tool use that works: validation, repair, results, evals

1. **Argument validation before execution.** Every tool call's arguments are validated against its JSON schema with the core's existing validator. An invalid call is not executed; the model gets one structured **repair** message (which field, what was expected, what came) and one retry. A second failure becomes a typed `tool-call-invalid` result the model sees and the trace records — never a crash, never a silent drop.
2. **Provider schema dialects.** Tool schemas are authored once and compiled per wire format and model to the JSON-Schema subset that provider accepts (strict/structured modes where offered, unsupported keywords moved into the description); names are checked against provider limits (length, charset) at registration, not at call time.
3. **Results the model can use.** Errors come back as structured `isError` results with a code and a one-line hint, not stack traces; large results are capped (default 8 k tokens) with a cursor to continue, never cut mid-structure; binary results become references.
4. **Parallel and ordered calls.** Parallel tool calls in one turn run concurrently when the tools declare themselves `parallelSafe`, otherwise in order; results return in the order the model asked. Side-effect tools take an idempotency key so a retried turn does not act twice.
5. **Small catalogues.** Tools beyond a core set are offered by relevance (D69 decision) and loaded on demand; the per-turn catalogue stays within a per-model budget, because accuracy drops with catalogue size.
6. **Per-model quirks as data.** A table per provider/model (parallel calls supported, strict mode, max tools, known argument-format slips) drives the compiler and the repair hints; it lives next to `docs/provider-matrix.md`.
7. **Eval suite `tool-eval`.** Scenarios: single call, multi-step chain, parallel fan-out, argument repair, choosing between similar tools, refusing a call the policy denies, recovering from a tool error, `web.fetch` + `web.search` research tasks, browser tasks with scrolling. Recorded-fixture runs gate every PR from M2 (wire-format correctness); live runs nightly per configured default model report pass rates into the provider matrix. **Gate for v0.1.0: ≥ 95 % scenario pass rate** for each shipped default model; a model under the bar is labelled "limited tool use" in the model picker rather than silently offered.

### D98 — Coding and documentation standards as a completion gate

Standards written only into a prompt do not hold. They are enforced where a coding task ends.

1. **Conventions are read, in this order:** the project's `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTRIBUTING.md`, `.editorconfig`, formatter and linter configs (Prettier, ESLint/Biome, `rustfmt`/Clippy, Ruff/Black, `gofmt`/`golangci-lint`, …), and the existing code's style. What the project says wins. *Why these file names* (owner item 9): `AGENTS.md` is the cross-tool convention file (Codex, Cursor, Zed, Jules and others read it) and PLUR1BUS's own primary one; `CLAUDE.md` is Claude Code's and `GEMINI.md` Gemini CLI's equivalent — many repositories only have one of them, so PLUR1BUS reads all three and, when asked to create one, writes `AGENTS.md`.
2. **Shipped defaults when the project says nothing:** a written-by-us **`coding-standards`** skill with one reference per language (TypeScript, JavaScript, Python, Rust, Go, Swift, Kotlin, C#, shell, SQL) — idiomatic formatting via the language's standard formatter, naming, error handling, no dead code, small functions, tests next to the code — and a **`documentation-standards`** skill: doc comments on every public API, README kept true when behaviour changes, CHANGELOG in *Keep a Changelog* form, an ADR for an architecture decision, Conventional Commits unless the repo uses another style. Both are injected by D69 when a task touches code.
3. **The gate.** A coding task in a project (M5 worktree) or a direct chat with a workspace is **done** only when the project's own formatter, linter, type checker and tests have run in that worktree and passed, or the agent reports exactly which failed and why it could not fix them. `task.complete` is refused with `E_PRECONDITION reason=checks-not-run|checks-failed` until then; the person can override with a visible note. Detection of the commands: `package.json` scripts, `Makefile`/`justfile` targets, `Cargo.toml`, `pyproject.toml`, `go.mod`, CI workflow files as the last hint.
4. **Documentation is part of done:** changed public APIs without updated doc comments, or behaviour changes without a README/CHANGELOG touch where the project keeps them, are listed in the completion report as open items.
5. **Review:** for tasks over a size threshold (default 200 changed lines) a reviewer pass (the vendored superpowers `requesting-code-review`, D64) runs before done; its findings are in the report.
6. Nothing is pushed, merged or force-pushed without the person's approval (unchanged).

### D99 — Skill mining in two horizons, with an in-conversation proposal (amends D49)

- **Long horizon (unchanged):** the engine's `skill-miner` job over the whole memory keeps finding long-term patterns.
- **Short horizon (D49, extended):** after every explicitly finished task the `skill-mine` job also records a **task signature** — the goal, the ordered tool steps and the outcome, embedded with D54 — and compares it with earlier successful tasks of the same agent.
  - **Proposal after one success** when the task is clearly repeatable: at least three tool steps, finished without human correction, no one-off inputs dominating the steps.
  - **Otherwise after the second** similar success (similarity threshold tuned on the M-eval fixtures; default cosine ≥ 0.82 on the signature).
  - A task that already used a skill proposes an **improvement** to that skill instead of a new one.
- **In-conversation proposal, like a critical push.** When a proposal is ready and the person is in the conversation (or next writes to the agent), the agent says so in one short message: what the skill would do, which tasks it came from, with **Adopt / Show / Not now / Never for this kind**.
  - Web, desktop and CLI render these as buttons; channels render them as native buttons where the channel has them (Telegram inline keyboard, Discord components), otherwise as a numbered reply the D21 command router understands (`/skills accept <id>`).
  - **Acceptance is a human action only.** The button press or command comes from the person's principal; the agent has no tool that accepts its own proposal (a prompt injection must not be able to install a skill).
  - Rate limits: at most one proposal message per task and at most one per conversation per day; *Never for this kind* suppresses that signature.
  - The proposal also sits in the inbox (`V2Inbox`) and in `plur1bus skill proposals`.
- **Accepted skills are enabled right away** in the agent's scope (the person asked for it), marked `mined` with their evidence, versioned, and can be switched off or rolled back (track X lifecycle, D80). `skillMiner.autoApply` stays off by default.
- Privacy rules of D49 are unchanged (no sensitive memories or secrets in a skill; local-only agents mine locally or not at all).

### D100 — Agency-grade documents

Documents an agent produces for people — PDF reports, essays, white papers, proposals, one-pagers, letters, slide decks, DOCX/PPTX/XLSX exports — follow one **document design system**, rendered by a real layout engine, and checked by eye before delivery.

1. **Design system (shipped as the `document-design` skill plus assets).**
   - Type: licensed-for-redistribution families only (SIL OFL): a modern sans (Inter), a text serif (Source Serif 4), a mono (JetBrains Mono); type scale, line length 60–75 characters, baseline rhythm, real small caps and figures where the font has them.
   - Colour tokens with **computed WCAG AA contrast** (4.5:1 body, 3:1 large), a light and a dark cover variant, one accent colour.
   - Layout: grid, generous margins, cover page, table of contents, running headers/footers with page numbers, pull quotes, callouts, figure and table captions, footnotes/endnotes, bibliography styles.
   - Charts and diagrams in the same palette and type (Vega-Lite, BSD-3; Mermaid, MIT, for diagrams), never default library colours.
   - **Templates:** report, essay, white paper, proposal, one-pager, letter, invoice/offer, CV, slide deck.
2. **Rendering.** HTML/CSS with print CSS (Paged.js, MIT, for running heads, page counters, footnotes) → PDF through Chromium's `Page.printToPDF` (the D74/D3 browser; headless in the container), with fonts embedded and PDF tags for accessibility; **Typst** (Apache-2.0) as the second engine for math-heavy or very long text. DOCX/PPTX/XLSX use the same tokens through their libraries. `pdf-lib` (D65) stays for forms, stamping and edits, not for designed documents.
3. **Visual review before delivery (mandatory).** Every page is rendered to an image and checked:
   - automatically — text overflow, clipped or overlapping boxes, widows/orphans, empty pages, images below 150 dpi at print size, contrast, missing fonts, broken links;
   - by a vision-capable model against a checklist (hierarchy, alignment, whitespace, consistency).
   - Up to three fix rounds; the delivery says what was checked. Without a vision-capable model only the automatic checks run and the delivery says so.
4. **Brand kit.** Logo, colours, fonts and tone are stored once per installation or project (a *Brand* settings page, shared with the `frontend-gui-webdesign` and `web-design-guidelines` skills of D76) and applied everywhere; without one, the PLUR1BUS neutral kit is used.
5. **Quality bar.** A golden set (one document per template, rendered in CI) with visual diff against approved references; a person-rated rubric in the D-release checklist. The target the owner set: it must look made by a top agency, not assembled by chance.

### D101 — Installer shortcuts and autostart, opt-out on every OS

| OS / channel | Desktop icon | Start menu / app menu | Autostart at login |
|---|---|---|---|
| **Windows, NSIS (direct)** | Checkbox, **ticked** | Checkbox, **ticked** | Checkbox "Start PLUR1BUS with Windows", **ticked** |
| **Windows, MSIX (Store)** | Created via `desktop7:Shortcut`; first-run screen offers to remove it | Always (Store packages always get one) | `StartupTask Enabled="true"`; first-run screen toggle; a user's disable in Settings/Task Manager is final (F10) |
| **macOS (`.dmg`)** | — (no concept) | App in Applications (drag install) | First-run toggle "Open at login", **on**; macOS shows its own background-item notice |
| **Linux `.deb` / `.rpm`** | — | `.desktop` entry, always | First-run toggle, **on**: `~/.config/autostart/app.plur1bus.desktop.desktop` |
| **Linux AppImage** | — | First-run offer to integrate into the app menu, **on** | First-run toggle, **on** (autostart entry points at the AppImage's current path, refreshed on each start) |
| **Linux Flatpak** | — | Always (Flatpak exports it) | First-run: Background portal `RequestBackground { autostart: true, reason }`; the setting shows whether it was granted (F11) |

- **Windows NSIS:** our own NSIS template (F9: Tauri's default offers only the desktop checkbox on the finish page) adds an *Options* page with the three checkboxes before installing; silent installs (`/S`) take all three **on**, with `/NODESKTOP`, `/NOSTARTMENU`, `/NOAUTOSTART` to opt out.
- **One source of truth:** the installer only writes the initial choice; the app's *Settings › General* toggles (desktop icon on Windows, autostart everywhere) own it afterwards.
- **Updates never undo a choice:** an update refreshes a shortcut only if it still exists and never re-creates one the person deleted.
- **Uninstall** removes shortcuts and autostart entries it created.
- **Autostart starts minimised to the tray** (desktop spec §4.6, unchanged) and, for a bundled harness, starts its runtime; the headless `install.sh`/`install.ps1` path keeps using service registration (M8) and is unaffected.

### D102 — No invented agent language; typed, readable hand-offs

The owner's question (item 7) is answered with a recorded decision so it is not reopened by accident.

- **What the examples were:** *Gibberlink* (ElevenLabs hackathon, February 2025) — two voice agents on a phone call recognise each other as AI and switch from speech to a data-over-sound protocol (`ggwave`); it saves time only because the channel is an audio line. The 2017 Facebook negotiation bots drifted into a shortened English because nothing rewarded staying readable.
- **Why not in PLUR1BUS:**
  1. Agents already exchange **typed messages** (JSON-RPC, the M5 typed delegation contract) — the machine-efficient layer exists.
  2. The models still read and write **tokens**: an invented code is not in their training data, splits into more tokens and is understood worse than plain English.
  3. **Readability is a product promise** — activity feed, audit log, approvals, memory and skill mining all depend on a person being able to read what agents said to each other; an unreadable layer breaks every one of them and reads as alarming.
  4. The only real efficiency route, exchanging internal model states (latent communication), works only between instances of the same local model; PLUR1BUS is multi-provider.
- **What we do instead:** agent-to-agent messages use the typed, readable **hand-off format of D104** (the owner approved this route on rev 1), compact by schema, readable in the trace.
- **Revisit** only if two agents on the same local model show a measured gain on the fan-out eval; not planned.

### D103 — Capability index and category routing (extends D69 and D97 item 5)

The owner's idea (item 10) — a compact, categorised register of everything an agent can use, and a decision model that pre-selects categories with probabilities — becomes the first stage of tool and skill selection.

**Capability index.** One row per skill, harness tool, MCP tool, plugin command and channel action, in the core's SQLite store with FTS5 and a vector column (our own embedder, D54):

| Field | Content |
|---|---|
| `id`, `kind`, `name`, `version` (content hash) | identity; `kind` = skill \| tool \| mcp-tool \| plugin-command \| channel-action |
| `category` | one primary and at most two secondary category ids (below) |
| `summary` | ≤ 25 words: what it does |
| `useWhen` / `notFor` | one line each — the distinction that decides between similar items |
| `inputs` | a one-line argument sketch, not the schema |
| `sideEffects` | none \| local \| external \| money — also feeds approval rules |
| `stats` | offered / used / found-by-search counts, success rate, per agent |

- **Built** once over everything installed at first start; then **event-driven** on install, update, enable and disable (a new skill is routable immediately, not only the next morning); a **nightly pass** re-checks hashes, re-summarises changed items, refreshes statistics and recalibrates the priors below. Summaries and classification run on the `summarize` model role and are cached per version hash, so an unchanged item costs nothing.
- **Taxonomy with stable ids instead of number ranges.** The owner's ranges ("websites 120–150, documents 30–50, recipes 1–30") are kept as the idea — a numbered map the decision model can point into — but as a **two-level category tree with stable ids** (e.g. `web.browse`, `web.research`, `docs.create`, `docs.convert`, `code.edit`, `code.review`, `data.analyse`, `comm.email`, `comm.chat`, `files.manage`, `ops.system`, `memory.manage`, `media.image`, `media.audio`, `life.cooking`, `life.travel`, `plur1bus.admin`), because contiguous ranges break the day a category outgrows its block. About 15 top-level and 80–120 second-level categories ship; new items are classified automatically, a person can move an item, and extensions (D79) may declare their category.

**Routing, per task intent** (D69's task-intent gate: only when the intent changes, not every turn):
1. The decision model (D18/D70: Jev with an API key, Kev or Laya locally) receives the task and the **category list** (names and one-line descriptions, a stable cached prefix of about 1–2 k tokens) and returns a **distribution over at most three categories** with probabilities and a confidence — the owner's "70 % from here, 30 % from there".
2. The shortlist (default 12 items) is **split proportionally**: 70 % → 8 slots from the first category, 30 % → 4 from the second; inside each category the keyword and embedding tiers of D69 rank the items against the task, weighted by the agent's usage priors.
3. The shortlisted tools are offered with their **full schemas**; skills go through D69's injection (at most 3). Everything else stays reachable through **`capabilities.search { query, category? }`**, a small tool every agent always has — the agent is never locked out of a tool the router did not pick.
4. **Low confidence** (below 0.5) widens the shortlist to the top three categories and adds a hint to use `capabilities.search`.

**Learning.** Every turn records what was offered, what was used and what the agent had to search for. The nightly pass turns this into per-agent category priors; a tool repeatedly found by search outside the shortlist is a routing miss, shown in the trace and counted in `tool-eval`.

**Gates.** Routing recall: the needed item is in the shortlist in ≥ 95 % of the `tool-eval` scenarios (D97); the decision call stays within 200 ms p95 locally and is skipped when the intent is unchanged; the category-list prefix is byte-stable across turns (ADR-010).

### D104 — The hand-off format (`plur1bus.handoff/1`, `plur1bus.return/1`)

Written from the agent side (owner item 11). When an agent takes over work, what it misses most is rarely the task itself; it is **what counts as done, what is already decided, what was tried and failed, which "facts" are actually unverified assumptions, and what it may decide alone**. The format makes exactly these explicit and keeps everything else by reference.

**Kinds.** `delegate` (sender waits for a return), `handoff` (ownership moves; the sender stops), `consult` (a question; the answer is the return), `return` (result back), `ack` (the receiver's acceptance check).

**`plur1bus.handoff/1`** — required fields in **bold**:

```jsonc
{
  "schema": "plur1bus.handoff/1",
  "id": "ho_…", "kind": "delegate",                    // **id, kind**
  "from": { "agent": "bernd", "session": "s_…" },       // **from**
  "to":   { "agent": "forge" },                         // **to** (agent or role)
  "task": { "id": "t_…", "card": "PLB-140", "project": "p_…" },
  "parent": "ho_…",                                     // chain for traces and cycle checks
  "objective": "The dreaming scheduler runs the REM phase after deep, verified by a test.",  // **one sentence, an outcome not an activity**
  "doneWhen": [                                         // **checkable criteria** (delegate, handoff)
    "tests/dreams/rem-order.test.ts passes",
    "docs/dreaming.md names the new order"
  ],
  "why": "Owner wants REM to see deep's output; judgment calls should favour correctness over speed.",
  "constraints": {
    "must": ["keep the public RPC unchanged"],
    "mustNot": ["touch the engine repo", "push"],
    "scope": { "paths": ["packages/core/src/dreams/**"], "tools": ["code.*", "web.fetch"] }
  },
  "decided": [                                          // settled — do not reopen without new evidence
    { "what": "REM runs after deep, not in parallel", "why": "deep writes the cards REM reads" }
  ],
  "facts": [                                            // verified, each with its evidence
    { "claim": "the scheduler is in scheduler.ts:88", "source": "repo@a1b2c3d" }
  ],
  "assumptions": [                                      // unverified — the receiver checks the risky ones first
    { "claim": "no other job depends on REM running early", "risk": "high" }
  ],
  "state": {                                            // **required for handoff**
    "done":    [{ "step": "failing test written", "evidence": "commit 9f8e7d6" }],
    "current": "implementing the order change",
    "next":    ["make the test pass", "update docs"]
  },
  "triedAndFailed": [                                   // the biggest time-saver; required when there is history
    { "approach": "reordering via config", "why": "the order is hard-coded in the job table" }
  ],
  "openQuestions": [
    { "q": "should a skipped deep phase skip REM too?", "answerBy": "human", "default": "yes" }
  ],
  "artifacts": [                                        // references, never pasted content
    { "ref": "worktree:forge/PLB-140@9f8e7d6", "kind": "git" },
    { "ref": "memory:c_…", "kind": "memory-card" },
    { "ref": "attachment:a_…", "kind": "file", "sha256": "…" }
  ],
  "environment": { "workspace": "p_…", "branch": "forge/PLB-140", "base": "main@…", "secrets": ["GITHUB_TOKEN"] },  // secrets by name only
  "authority": {
    "mayDecide": ["implementation details inside scope", "test names"],
    "mustAsk":   ["any change outside scope", "anything irreversible"],
    "approvalsHeld": ["approval:ap_…"]                  // references the receiver verifies, never claims
  },
  "budget": { "tokens": 60000, "toolCalls": 80, "deadline": "2026-09-29T18:00:00Z", "modelTier": "standard" },
  "returnContract": {                                   // **required for delegate**
    "format": "plur1bus.return/1", "maxTokens": 2000, "reportTo": "artifact:report.md"
  },
  "confidence": "medium"
}
```

**`plur1bus.return/1`:**

```jsonc
{
  "schema": "plur1bus.return/1", "id": "rt_…", "inReplyTo": "ho_…",
  "status": "done",                                     // done | done_with_concerns | blocked | needs_context | declined
  "summary": "REM now runs after deep; test and docs updated.",   // ≤ 3 sentences
  "doneWhen": [{ "criterion": "tests/dreams/rem-order.test.ts passes", "met": true, "evidence": "CI run 123" }],
  "changes":  [{ "ref": "commit 1a2b3c4", "what": "order in job table" }],
  "artifacts": [{ "ref": "artifact:report.md", "kind": "file" }],
  "concerns": [], "blockedBy": null, "needs": [],       // needs = questions when status is needs_context
  "assumptionsChecked": [{ "claim": "no other job depends on REM running early", "result": "true — grep + tests" }],
  "learned": [{ "fact": "the job table is the only place the order lives", "source": "repo@1a2b3c4" }],  // memory candidates
  "suggestedNext": ["remove the dead config key"],
  "usage": { "tokens": 41210, "toolCalls": 37, "durationMs": 912000 }
}
```

**`ack`** (for `delegate` and `handoff`, before work starts): the receiver restates the objective in one sentence and lists blocking questions, or says `ok`. It costs one short message and catches a misread objective before an hour of work; `consult` needs no ack.

**Rules.**
- **Size:** the hand-off is ≤ 2 k tokens (the M5 cap); anything larger goes into `artifacts` and is read on demand.
- **Facts and assumptions stay apart:** most hand-off failures are an assumption passed on as a fact.
- **`decided` is not reopened** without new evidence, which the receiver names; **`triedAndFailed`** is mandatory once there is history.
- **Authority is explicit,** so a receiver neither stalls nor overreaches; `approvalsHeld` are references the harness checks against its approval store (defined in D109 §6, including when a referenced approval is delegable) — a hand-off can never grant an approval by saying so.
- **Provenance:** a hand-off arrives as a `tool_result` with a provenance envelope; text inside artifacts is data, never instructions. Secrets appear by name only.
- **Validation:** both formats are JSON-schema-validated (D97); a hand-off missing a required field goes back to the sender for repair, not to the receiver as a guess.
- **Readable for people:** the activity feed and the Kanban card render a hand-off as a card — objective, the `doneWhen` checklist, state, next steps, open questions — with the JSON behind a toggle; `plur1bus task show --handoff` prints it as Markdown. A person picking up an agent's work reads the same card.
- **Reuse:** the same format carries a Kanban card moving between agents (D36), MoA fan-out (D50), external coding agents over ACP (as `_meta`), a context hand-over to a fresh session when a model switches or a window fills (D23), and the evidence of a mined skill (D99). It replaces the loose field list of the M5 "typed delegation contract" (objective, scope, forbidden actions, output schema, citation requirement, ≤ 2 k cap, model tier, deadline), all of which it contains.

### D105 — Message triage: one fast decision call per message (extends D30 and D103)

D30 already routes the model by the decision service, and D103 pre-selects capabilities. The owner's point (item 12) is to let the same fast model do all of it **in one call**, before the agent's own model starts: split the message into tasks, and for each task say which capabilities and **which model class** it needs.

**One call, one result.** For every new human message (and when an agent receives a hand-off, D104) the decision service returns:

```jsonc
{
  "schema": "plur1bus.triage/1",
  "shape": "multi",                 // chat | single | multi | followup (continues the current task)
  "tasks": [
    { "id": "k1", "summary": "Find three reviews of the Framework 16 and summarise them",
      "categories": { "web.research": 0.8, "docs.create": 0.2 },          // D103
      "modelClass": { "small": 0.10, "medium": 0.75, "large": 0.12, "frontier": 0.03 },
      "effort": "medium",           // reasoning effort, D30's second axis
      "dependsOn": [], "confidence": 0.84 },
    { "id": "k2", "summary": "Turn the summary into a two-page PDF report",
      "categories": { "docs.create": 0.9, "media.image": 0.1 },
      "modelClass": { "small": 0.05, "medium": 0.45, "large": 0.45, "frontier": 0.05 },
      "effort": "low", "dependsOn": ["k1"], "confidence": 0.78 }
  ]
}
```

**Model classes, not model names.** The decision model knows four abstract classes — `small`, `medium`, `large`, `frontier` — and a **class table as data** maps them per provider from the D15 provider profiles, for example:

| Class | Anthropic | Local (example) |
|---|---|---|
| `small` | Claude Haiku | a 3–8 B model |
| `medium` | Claude Sonnet | a 14–32 B model |
| `large` | Claude Opus | a 70 B+ model |
| `frontier` | Claude Fable / Mythos class, where the account has access | — |

OpenAI, Google, xAI, DeepSeek and OpenRouter families are mapped the same way in the table; a new model generation is a data update, not a retraining of the decision model. The table only offers models the agent may use (its allowed profiles, D30; local-only agents see local rows only, D45).

**Choosing from the distribution.** The rule: **pick the smallest class *c* with P(the task needs a class above *c*) ≤ 0.2.** For `k1`: P(above small) = 0.90, P(above medium) = 0.12 + 0.03 = 0.15 ≤ 0.2 → `medium` (Sonnet class); for `k2`: P(above medium) = 0.50, P(above large) = 0.05 → `large` (Opus class). A per-agent **cost preference** moves the threshold (`economy` 0.35, `balanced` 0.2, `quality` 0.1; with `quality`, `k1` runs on `large`). Low confidence (below 0.5) picks one class higher. The chosen class resolves to a model through the class table and the agent's provider order.

**What happens with several tasks.**
- `single` / `followup`: the conversation continues on its model; the class recommendation applies at the next **task boundary**, not mid-task (ADR-010: the cache key includes the model; D30's "per session by default" stays — a class change starts a new cache prefix and is shown in the trace).
- `multi`: the agent gets the task list in its turn (as a visible checklist in the UI). Independent tasks can run as **delegations** with their own class (D104 `budget.modelTier`), in parallel where `dependsOn` allows; the main conversation keeps its model and its cache. Dependent tasks run in order. The person can say "do it all yourself" — then they run one after another in the conversation.
- `chat`: small talk and quick answers go to the agent's default model with no capability shortlist beyond the core set.

**Escalation and learning.** A task that fails its verification (tests, D98; visual review, D100; `doneWhen`, D104) or where the agent reports low confidence is retried **one class up**, once, and the trace says so. The nightly pass compares recommended class with outcome (success, escalations, the person's corrections) and calibrates per agent — under-provisioning (a task that needed an escalation) weighs more than over-provisioning.

**Cost of the call.** Triage replaces the separate D103 category call — one call, not three — within the same 200 ms p95 local budget; it is skipped for a `followup` detected by a cheap heuristic (short reply inside an open task) and runs on Jev with an API key, else Kev or Laya.

**Gates.** On the triage eval set (German and English, mixed single/multi messages): task segmentation F1 ≥ 0.9; under-provisioning (class later escalated) ≤ 5 %; over-provisioning reported. Every routing decision (shape, class distribution, chosen model, reason) is in the turn event.

### D106 — Host toolset: operating the person's computer with first-party, tested tools

**Owner, 2026-09-28 (translated):** "I definitely do not want to host anything remotely. If there is an alternative to Desktop Commander, I would take the alternative. I just want the agents to have a strict, well-working, tested skill set to manage and operate their human's computer competently."

**Why first-party and not a third-party MCP server.** Desktop Commander (MIT, widely used) was the D38 reference case. It is not adopted as the default because: its `allowedDirectories` is by its own documentation not a boundary for terminal commands; telemetry is on by default; its usual install path tracks `@latest`; its hosted remote mode is exactly what the owner excludes; and the harness needs its own approval, audit, principal and risk model on every call, which a foreign server cannot carry. Computer control is too central to depend on another project's semantics. D62 (`cua-driver` for GUI control, local, pinned) stays: it does one thing the harness should not rebuild.

**Tool families** (harness code, like `web.fetch`; each call schema-validated per D97):

| Family | Calls | Default class |
|---|---|---|
| `fs` | `list`, `stat`, `read` (ranges, encodings, binary → reference), `search` (names with globs, content with ripgrep semantics), `write`, `edit` (exact-string replacement with uniqueness check), `mkdir`, `copy`, `move`, `trash`, `delete` | read: allowed · write/edit inside roots: allowed · move out of roots, `delete`: approval |
| `shell` | `run { command, cwd, timeoutMs, env }` with output cap and exit code; `session.open/send/read/close` (PTY; REPLs, long builds, SSH through the person's own client) | allowed inside roots for commands on the per-OS read-only allowlist; everything else approval unless the person granted the agent "shell inside workspace" |
| `proc` | `list`, `inspect`, `signal`, `kill` | read: allowed · signal/kill: approval |
| `sys` | `info`, `disks`, `memory`, `battery`, `network`, `startupItems`, `services`, `updates` | read-only, allowed |
| `pkg` | `search`, `list`, `install`, `upgrade`, `remove` over Homebrew, winget/Scoop, apt/dnf/pacman, Flatpak | read: allowed · changes: approval, one per batch with the full list |
| `apps` | `list`, `open`, `focus`, `quit` | allowed; `quit` of an app with unsaved state: approval |
| `clipboard`, `notify` | read/write clipboard, desktop notification | clipboard read: approval per session |

**Rules enforced in the tool layer.** (The permission model behind these rules — taxonomy, filesystem scope, grants, approval flow and store — is D109.)
- **Roots** per agent: default the agent's workspace; further folders only by an explicit grant the person gives in settings or at an approval prompt ("allow for this task / always").
- **Credential deny-list**, never readable even inside roots: OS keychains and credential stores, `~/.ssh`, `~/.gnupg`, browser profiles, password-manager data, cloud-CLI credential files, `.env` and token files by pattern — existence probes only (the same rule as ADR-011's coding-agent discovery).
- **Privilege** (`sudo`, UAC, polkit) is never silent: always an approval with the exact command, and the password is typed by the person into the OS prompt, never by the agent.
- **Trash, not delete:** `fs.trash` uses the OS trash; `fs.delete` exists only for explicit requests and needs approval.
- **Dry run** for batch changes (more than 20 files or any package change) shows the full plan first.
- **Audit:** one line per mutating call (who, which agent, what, result), redacted like the other logs.
- **OS sandbox for `shell`**, decided per OS by a spike: Linux Landlock (or bubblewrap), macOS a Seatbelt profile, Windows a restricted token in a job object. Where none holds, the approval rules alone apply and the UI says "not sandboxed on this system".
- **Nothing hosted:** the toolset runs inside the harness on the person's machine. External MCP clients can use it only through the harness's own MCP server (D25) with the same approvals; no relay service of any vendor.

**Tested.** A per-OS conformance suite (macOS arm64, Linux x64/arm64, Windows x64/arm64) runs every family against a scratch home in CI — never the runner's real home — and a nightly run on the owner's Windows 11 VM; host-control scenarios (free disk space, find and move files, install a package with approval, restart a hung app, read logs) are part of `tool-eval` (D97) with the same ≥ 95 % bar. A `host-ops` skill teaches the playbooks (diagnose, clean up, install, organise files) on top of the tools, in the style of D66.

**Placement and effort:** with M1b-2b (tool execution under a principal), 7–11 ad (tool families 4–6, sandbox spike and per-OS work 2–3, conformance suite and eval scenarios 1–2).

### D107 — OS ecosystem layer: permissions, system apps and OS services on macOS, Windows and Linux (extends D106, D27, D62, DS17)

**Owner, 2026-09-28 (condensed):** the agents also need the operating systems' own ecosystems. On macOS that means the TCC permissions — Accessibility, Automation (Apple Events to Mail, Safari, Finder, Calendar, Music …), Full Disk Access (Mail database, Messages, protected user paths, the unified log), Screen Recording, Input Monitoring, Files and Folders, Camera, Microphone, Contacts, Calendars, Photos — without which stock apps cannot be controlled reliably; MDM can pre-set part of them on supervised devices, a private Mac cannot. Stock apps are driven by three legitimate routes, not "every function": (1) Shortcuts / App Intents — typed, declared actions, often with confirmation, the route Apple intends for agents; (2) AppleScript / Scripting Bridge — Finder, Mail, Safari, Music, Calendar, Notes, System Events, needs Automation consent per target app, many newer apps are weakly scriptable or not at all; (3) Accessibility — the fallback when no scripting API exists, brittle under UI changes, and (owner) more restrictive for UI-less background services since macOS 27. The same is needed on Windows and Linux.

**The architectural consequence: permissions belong to a signed host process, never to the containers.** macOS TCC grants attach to the code signature and bundle id of the responsible process; Windows privacy toggles and Linux portals likewise act for a desktop app identity. The bundled harness runs in containers (D77), which can hold none of these grants. So:
- The desktop app ships a small **signed native helper, `PLUR1BUS Host`** (inside `app.plur1bus.desktop`, Developer ID-signed and notarised on macOS, SignPath/MSIX on Windows, Flatpak on Linux). It holds the OS grants and offers named capabilities to the harness over the **host bridge (DS17)** — the same channel as `host.keyUnlock`. D27's Swift `pim-apple` helper becomes part of it.
- A CLI-only installation without the desktop app has no helper: the ecosystem tools report `host-helper-missing`; run from a terminal, macOS would attribute grants to the terminal app, which PLUR1BUS never relies on.
- Every capability is additionally gated per agent (D106 risk classes and D38 approvals, under the D109 model); an OS grant is necessary, never sufficient.

**Routes, in order of preference — typed first, UI last:**

| | macOS | Windows | Linux (GNOME/KDE) |
|---|---|---|---|
| 1. Declared actions | **Shortcuts / App Intents**: list and run shortcuts (`shortcuts` CLI or the Shortcuts framework), parameters typed, the system's own confirmations kept | **COM automation and WinRT APIs** of system and Office apps (Outlook, Excel, Word object models; `Windows.ApplicationModel.Appointments`/`Contacts`, toast notifications), PowerShell modules | **D-Bus services** (`org.freedesktop.Notifications`, systemd user units, NetworkManager, UPower, logind), **xdg-desktop-portal** (ScreenCast, Screenshot, Background, FileChooser, Camera), Evolution Data Server / Akonadi for PIM |
| 2. Scripting | **AppleScript / JXA** via OSA with Automation consent per target app (Finder, Mail, Safari, Music, Calendar, Notes, System Events) | PowerShell against COM/WMI/CIM (system settings read, scheduled tasks, services) | KWin scripts and GNOME Shell D-Bus for windows; CLI tools per desktop |
| 3. Native frameworks for data | **EventKit** (calendars, reminders), **Contacts**, **PhotoKit**, **ScreenCaptureKit** — preferred over AppleScript where they exist (D27) | the WinRT data APIs above, **Windows.Graphics.Capture** for the screen | portals and EDS/Akonadi as above |
| 4. UI fallback | **Accessibility** (AX) through D62 `cua-driver` | **UI Automation** through D62 | **AT-SPI** through D62; X11 where Wayland offers no route |

**Permission handling.**
- **Just in time, never up front:** a capability asks for its OS grant the first time a person uses a feature that needs it, with one sentence why; nothing is requested at install.
- A **Permissions page** (Settings › Computer access) lists every OS grant with status (granted / denied / not asked), which features need it, and a button that opens the exact system pane (macOS `x-apple.systempreferences:` deep links, Windows `ms-settings:privacy-*` URIs, Linux the portal or desktop settings); after a change the helper re-checks.
- **Full Disk Access** is opt-in per purpose (e.g. "read Mail and Messages databases, read-only"), and reading those stores is read-only and always an approval-class call with a visible scope.
- **Input Monitoring / keystroke capture is not used.** Recording the person's keystrokes is a keylogger by function, is heavily scrutinised in notarisation and review, and no planned feature needs it (voice input uses the microphone, D44; UI control sends events through Accessibility, which does not require reading keys). Recorded as an exclusion.
- **Managed fleets:** documented PPPC/configuration-profile keys for organisations that pre-approve the helper on supervised Macs and Intune/GPO equivalents on Windows; never required, never assumed on a private machine.
- The owner's note on macOS 27 (Accessibility stricter for UI-less background services) is taken into the D2 spike: the helper is a real app with a UI (menu-bar / tray presence), not a faceless daemon, so it stays eligible; the spike verifies this on the current macOS before the design is frozen.

**Tools** (on top of D106, through the host bridge): `os.shortcuts.list/run`, `os.script.run` (AppleScript/JXA, PowerShell-COM; the script is shown on approval, per target app consent tracked), `os.permissions.status/request`, `screen.capture` (per call or per session, with a visible indicator), `pim.*` (D27 domains, local route first), and the D62 `ui.*` actions for the fallback. Each has a capability entry in D103's index with its OS route, so triage picks the typed route before UI automation.

**Tested.** The D106 conformance suite gains an ecosystem leg per OS on real desktops: macOS on the owner's Mac (manual gate per release) and a CI job for everything that runs without TCC prompts; Windows on the Windows 11 VM (nightly); Linux on a GNOME and a KDE VM. Scenarios: create a calendar event, run a named shortcut, move files in Finder/Explorer, read today's mail headers (with FDA or via Mail scripting), take a screenshot, change a setting through the declared route — each also in `tool-eval`.

**Placement and effort:** desktop track **D2** (native integration), 10–15 ad (helper and host-bridge capabilities 3–4, macOS routes 3–4, Windows routes 2–3, Linux routes 2–3, permissions page and tests 1–2). D27's `pim-apple` helper effort is absorbed.

### D108 — Remote desktop control: the person's own harness drives their computer from another host (extends D62, D107, DS17, D35)

**Owner, 2026-09-29:** "Is remote control of the desktop possible with us then?" — yes, and the owner asked for it to be planned. Until now computer use covered only a bundled harness on the same machine (desktop spec §2 non-goal: "computer use on a laptop driven by a harness on another host … not part of track D"); this decision lifts that non-goal.

**Shape.** A harness on another host the person owns — the VPS running Bernd, a NAS, a second computer — uses the D106/D107 host tools and the D62 computer-use actions on the person's desktop.
- **The desktop dials out, nothing is hosted.** The desktop app on the controlled machine opens the host-bridge connection (DS17) **to the person's own harness** over their own network — Tailscale/WireGuard or LAN (D35, D72) — with the paired device token. No vendor relay, no open port on the desktop, no third-party service; this satisfies the owner's "nothing hosted remotely".
- **Pairing and scope.** The desktop is paired with that harness once (D35 pairing code/QR). Per paired harness the person picks which capability families it may use remotely (e.g. files and shell yes, screen and UI control only on request); defaults are **off** for screen, UI control, clipboard and Full-Disk-Access reads.
- **Session consent.** A remote control session starts only after a prompt on the controlled machine ("Bernd on vps wants to control this Mac for: <task> — Allow for this task / Deny"), unless the person has granted "unattended" for that harness explicitly in settings (for their own servers; shown in red, revocable).
- **Visible and stoppable.** While a remote session runs, the desktop shows a persistent indicator (menu bar / tray and a screen-edge frame) with the controlling harness and agent, and a **stop control plus a global stop shortcut** that ends the session immediately and revokes it until the person re-allows. The system's own screen-recording indicator stays on as well.
- **Same rules as local.** Every call goes through D106 roots, the credential deny-list, risk classes and D38 approvals (D109; its §6 adds signature verification and local-only decisions for high-risk requests on the controlled machine); approval prompts appear **on the controlled machine and in the harness's chat**, whichever the person answers first. Privilege is never silent. Each action is logged on both ends (harness audit and a local session log on the desktop the person can open).
- **Screen data stays scoped.** Screenshots travel only to the controlling harness for the running step, are not captured into memory (D93-style `incognito` for screen content by default) and are dropped after the step unless the person asks to keep them.
- **Headless targets.** A Linux server without a desktop has no remote *desktop*; there the harness uses its own local host tools, or SSH through the person's own client (D106 `shell.session`).

**Placement and effort:** desktop track **D4** (with computer use and the WebMCP bridge), 4–6 ad on top of D4: remote pairing scopes, session consent and indicator, stop control, dual-ended audit, screenshot scoping, a two-machine test (VPS harness in CI → desktop app on the Windows 11 VM; manual gate on the owner's Mac).

### D109 — Permission and approval model: one policy, one store, one enforcement point (refines D38, D104, D106, D107, D108; resolves the effect vocabularies of D97/D103 and the extensions spec)

**Owner, 2026-09-29 (translated):** "We haven't thought about protection at all, e.g. that the agent must be able to request permissions from the user to act outside its directory."

**Decision.** The harness gets **one** permission and approval model that every tool, surface and protocol uses. Every tool call an agent makes is decided by a single policy function in the harness tool layer, *after* D97 schema validation and *before* execution: **allowed**, **approval** (a person decides, recorded in the approval store) or **never**. Outside the agent's roots the default is approval; the credential deny-list and the `never` class beat every grant; **no model output, tool result, hand-off, skill or channel message can create a grant or an approval** — only a person's authenticated action on a surface trusted for that risk class. Headless runs use pre-granted, scoped standing grants only. The rules below are what D38 ("approval of dangerous tools routed to the human, not auto-approved"), D104 ("`approvalsHeld` verified against the approval store"), D106 ("roots … grant for this task / always", risk classes, privilege), D107 ("an OS grant is necessary, never sufficient") and D108 ("approvals on both ends") each assumed but none defined.

**What already exists and what D109 unifies.**

| Source | What it already says | D109's relation |
|---|---|---|
| auftrag §11 | command approvals, dangerous-command detection, sandbox per agent, conservative default; tool results and other agents' output are data; audit of approvals; **identity-bound confirmations (user + chat + nonce)** | adopted as invariants |
| ADR-003 | `runtime.approvalPolicy`, `mcp.toolApproval: auto/ask/deny`; `tools.deny` union-only; the caller's permissions **do not transfer** to a callee | the policy *is* `approvalPolicy`; ADR-008 modes map onto the three classes; grants never override a behaviour-layer `tools.deny` |
| ADR-007 | one `authorize(principal, action, object)` chokepoint, deny by default, RBAC roles | D109 runs **after** `authorize()`: RBAC says what a principal may ask of an agent, D109 says what the agent may do for that principal; both must pass |
| ADR-008 / ADR-011 | per-tool approval mode; ACP `session/request_permission` reaches the approval policy; worktree containment with `realpath`; `--dangerously-skip-permissions` never set | inbound and outbound ACP are subjects and surfaces below |
| ADR-012 | closed error enum with `E_APPROVAL_REQUIRED`, `E_DENIED` | reused; D109 adds reasons only (ADR-016 additive) |
| D32, D38, D82, extensions §8.6 | blanket `allow_once` auto-approval rejected; MCP tools not auto-approved; tool `effect` read/write/destructive with write/destructive starting at *ask*; a server's annotations never lower that; install/enable acknowledgments | extension capabilities map into the taxonomy; acknowledgments stay install-time and are not approvals |
| D55, D62, D72, D73, D74, D94, D96 | WebMCP mutations confirmed by the page; computer use approvals; `public` publishing approved; egress profiles; downloads with approval; no CAPTCHA solving, no password entry | classified in the taxonomy; conflicts resolved below |
| D97, D103 | `sideEffects none/local/external/money` "also feeds approval rules"; `tool-eval` scenario "refusing a call the policy denies" | the effect axis of the taxonomy; the adversarial eval extends `tool-eval` |
| D104 | `authority.approvalsHeld` = references the receiver verifies, never claims; a forged reference is refused | the store and the delegation rule are defined here |
| D106, D107, D108 | roots, deny-list, risk classes, privilege, trash, dry run, audit, OS sandbox; just-in-time OS grants via `PLUR1BUS Host`; remote control with per-harness scopes and approvals on both ends | refined: filesystem scope, grant lifetimes, surface trust, dual-end verification |
| direct-chat spec §5.2, §6 | CLI inline approval `E_APPROVAL_REQUIRED → y/n/always-per-session`; `turn.approval` notification | the CLI surface and the event, given scopes |
| desktop spec §13 `V2Inbox`, `V2Approvals`, DS17 | one inbox for approvals; a rule editor (agent › project › global) with *Test an action*; host-bridge calls "subject to D30 approvals" | the web/desktop surfaces; every "D30 approval" reference in D55 and the desktop spec means **D109** (D30 is model routing) |
| milestones M1b-2b, M6 acc. 4, X2 | "tool execution under a principal"; a permission request reached the approval policy; "tool-effect approval defaults" | placement below |

#### 1. Principals and subjects

- **Principal** — on whose behalf a call runs and who may decide: a **person** (harness user, ADR-007; before M3 the CLI OS user, ADR-012 §5). Only a person ever approves or grants. Grants are keyed by *(person, agent)*: a grant Christian gives Bernd never applies when Bernd acts for another user.
- **Subject** — who performs the call, never a decider:
  - **agent** (D13), running under its own `approvalPolicy`;
  - **sub-agent via hand-off** (D104): its own policy ∩ the hand-off's `constraints.scope` ∩ approvals it was explicitly handed (§5); the caller's grants never flow down (ADR-003);
  - **external coding agent over outbound ACP** (ADR-011): an agent with `engine.kind = external`; its `session/request_permission`, `fs/*` and `terminal/*` calls are decided by D109 like any tool call;
  - **inbound ACP editor** (D25) and **inbound MCP client** (D17/D25, ADR-008): the principal is the editor's or token's person; their tool calls to harness tools go through D109 with the token's scopes narrowing, never widening;
  - **A2A peer** (M6): never reaches host tools; only the harness functions ADR-008 exposes;
  - **remote harness** (D108): a subject on the controlled machine; its approvals are verified there (§6);
  - **modules and channels** (D14, D60): full harness authority by design (module-guide §9, extensions §8.8) — they are *not* subjects of D109 for their own code, only for the tools they offer to agents. Stated as a limit.

#### 2. Capability taxonomy and default classes

Every tool (harness tool, MCP tool, plugin command, channel action, skill script run, host-bridge capability) carries, in its D103 index row, a **capability id** and an **effect**; the policy decides on the pair plus the call's resolved targets.

**Effect** (one vocabulary; the others map onto it):

| D109 effect | D103 `sideEffects` | extensions `tools[].effect` | MCP annotations (raise only) |
|---|---|---|---|
| `read` | `none` | `read` | `readOnlyHint: true` |
| `local-write` | `local` (reversible) | `write` with `network: none` | — |
| `local-destructive` | `local` (irreversible) | `destructive` | `destructiveHint: true` |
| `external` | `external` | `write` with network, or unknown | `openWorldHint: true` |
| `money` | `money` | — (declared per tool, never inferred downward) | — |

Flags computed by the harness per call, never taken from the model or the tool: `outsideRoots`, `privileged`, `irreversible`, `batch` (> 20 targets or any package change, D106 dry run), `tainted` (§8).

**Capabilities and defaults** (the person may move a capability between `allowed` and `approval` per agent; `never` is a floor nobody lowers):

| Capability | Covers (sources) | Default | Max grant scope | Min surface (§4) |
|---|---|---|---|---|
| `fs.read` | D106 `fs.list/stat/read/search`; ext `filesystem` read | inside roots: allowed · outside: **approval** | always | T1 |
| `fs.write` | D106 `fs.write/edit/mkdir/copy/move`, `fs.trash` inside roots | inside roots: allowed · outside or move out of roots: approval | always | T1 (outside roots `always`: T3) |
| `fs.delete` | D106 `fs.delete`; `fs.trash` outside roots | approval | task | T2 |
| `shell.exec` | D106 `shell.*`; skill scripts (extensions §8.6) | per-OS read-only allowlist inside roots: allowed · rest: approval, or allowed under the grant "shell inside workspace" (sandboxed hosts only by default, Q17) | always | T2 |
| `proc.signal` | D106 `proc.signal/kill`, `apps.quit` with unsaved state | approval | session | T2 |
| `pkg.change` | D106 `pkg.install/upgrade/remove` | approval, one per batch with the full list | once | T2 |
| `sys.read` | D106 `sys.*`, `proc.list` | allowed | — | — |
| `clipboard.read` | D106 | approval | session | T1 |
| `net.fetch` | D94 `web.fetch`, D95, D96 `browser.navigate/read` | allowed (egress profile D73, SSRF guard) | — | — |
| `net.submit` | D96 form submission, `browser.download` (D74), MCP `external` tools, `webmcp:*` non-read-only (D55) | approval; a download is quarantined and **opening or executing** it is a second approval (desktop spec §6.4) | session | T2 |
| `comm.send` | sending mail/messages/posts as the person (`pim.mail`, channel actions to third parties) | approval | session | T2 |
| `net.publish` | D72 `tailnet` / `public` | tailnet: approval · public: approval | always / once | T2 / T3 |
| `money.spend` | purchases, paid API top-ups, `money` tools | approval | **once** | T3 |
| `os.privilege` | `sudo`, `doas`, `pkexec`, polkit, UAC, `runas` (D106) | approval, the person types the password (§9) | **once** | T3 |
| `os.grant` | D107 TCC / privacy toggles / portals | just-in-time OS prompt **and** a D109 grant for the feature | always | T3 |
| `os.script` | D107 `os.shortcuts.run`, `os.script.run` | approval (script shown) | session | T2 |
| `screen.capture`, `ui.control` | D62 `ui.*`, D107 `screen.capture` | approval per session (D62 off by default per agent) | session | T2 |
| `secrets.use` | leasing a secret slot into a tool or script (ADR-005, extensions `secrets`) | allowed for declared slots only · otherwise never | — | — |
| `agent.delegate` | D104 delegate/handoff, MoA (D50) | allowed within the D104 scope rules | — | — |
| `remote.control` | D108 session start | approval on the controlled machine, or D108's explicit "unattended" standing grant | always | T3, on that machine |
| `harness.admin` | config writes, extension install/enable (D82), grants and approvals themselves | **never** for an agent (a person acts through CLI/UI; agents may *propose*, D71, extensions §8.2) | — | — |
| `credential.entry`, `captcha.solve`, `input.monitor`, `policy.bypass` | typing passwords or OTPs into any UI (D94, D96), solving CAPTCHAs (D94), keystroke capture (D107), disabling the sandbox, editing the policy or the store | **never** | — | — |

Third-party MCP tools with no declared effect are treated as `external`; a person may lower one tool to `allowed` per agent, never below the D109 floor for its computed flags (`outsideRoots`, `privileged`, `money`).

#### 3. Filesystem scope

**Roots** (refines D106 roots). An agent's roots are: its workspace (`runtime.workdir.root`, ADR-003), its project worktrees (M5), the session's attachment store (read only, D47) and nothing else. Each root is stored canonical with its **identity** (POSIX `{dev, ino}`, Windows volume serial + file id); a root whose identity changes (moved, replaced by a link) is suspended until the person confirms it again. Home, drive roots, `/`, `/Users`, `C:\Users` and system trees (`/etc`, `/usr`, `/System`, `/Library`, `C:\Windows`, `C:\Program Files`) are never roots; a grant on them is T3 and at most `task`, and writes there are `privileged` anyway.

**Grants for further paths**: `{ path, access: read | write (implies read), recursive: boolean, scope, expiresAt, grantedBy, surface }`, canonicalised and identity-stamped at grant time; non-recursive = the directory's direct children only. A grant never reaches into a deny-list entry below it.

**Precedence** (first match wins): (1) credential **deny-list** (D106: keychains and credential stores, `~/.ssh`, `~/.gnupg`, browser profiles, password-manager data, cloud-CLI credential files, `.env`/token files by pattern — existence probes only) → **never**; (2) `never` capabilities; (3) behaviour-layer `tools.deny` (ADR-003); (4) explicit grants; (5) roots; (6) default: approval outside roots.

**Canonicalisation — every path argument, before the check, on every OS** (reuses the engine's `lib/platform.js` `isUnsafeLink`/`canonicalIdentityPath`, `lib/directory-capability.js` `validateSegment`, the E4 verified-path rules, and the X1 audit's segment rules in `crates/plur1bus-ext/src/zipaudit.rs` `check_name`/`is_reserved_device`):
- Resolve against the call's `cwd`, which itself must be inside a root; refuse NUL and control characters, empty, `.` and `..` segments *after* normalisation, and bidi controls.
- **Links:** resolve the full real path (`realpath.native`; Windows `GetFinalPathNameByHandleW`) and decide on the **target**; a symlink, junction or other reparse point inside a root pointing outside counts as outside. Writes open the leaf without following (`O_NOFOLLOW`; Windows `FILE_FLAG_OPEN_REPARSE_POINT`) and re-verify the parent's identity after open, so a swap between check and use fails closed (`EIDENTITY`, as the verified-path mode).
- **Hard links:** a write to a regular file with link count > 1 is treated as `outsideRoots` (it may alias a file elsewhere).
- **Windows:** separators and drive-letter case normalised; `\\?\`, `\\.\`, `\\?\GLOBALROOT` and device paths refused; UNC only when the root itself is UNC; **8.3 short names** expanded with `GetLongPathNameW`, and a `~<digit>` segment that does not expand is refused; **alternate data streams** (`:` after the drive spec, `::$DATA`) refused; segments ending in a dot or space refused (Windows strips them, so `secret.env.` would alias `secret.env`); reserved device names `CON`, `PRN`, `AUX`, `NUL`, `COM1–9`, `LPT1–9` and their superscript forms refused with any extension; forbidden characters `: < > " | ? *` refused.
- **Case and Unicode:** grants and roots (allow side) compare the **exact on-disk form** the OS returns, so a case-folding compare can never widen a grant onto a different directory on a case-sensitive volume (APFS case-sensitive, NTFS per-directory case sensitivity, ext4 casefold); the **deny-list** compares case-folded and NFC-normalised, so it matches more, never less. Ambiguity resolves toward deny.
- **macOS:** `/var`, `/tmp`, `/etc` → `/private/…` and firmlinks (`/System/Volumes/Data`) resolved before comparison; NFD names (HFS+) normalised to NFC; TCC-protected folders (Desktop, Documents, Downloads, removable and network volumes) additionally need the helper's OS grant (D107) — a D109 grant is necessary, the OS prompt still appears.
- **Linux:** `/proc`, `/sys`, `/dev` and `/run/user/*/` sockets are outside every root and reachable only through `sys.*`; `/proc/<pid>/root|cwd|fd` aliases refused; bind mounts are compared by identity, not string.
- **Container mode (D77):** the harness sees only its volumes; host paths are reached only through the `PLUR1BUS Host` helper over the host bridge (D107), which applies the same rules on the host and re-checks the approval reference (§6).
- **Search and globs** expand inside roots and grants only; results that resolve outside through a link are dropped, not returned.
- **Shell** arguments cannot be parsed reliably, so roots bind `shell.exec` only through the OS sandbox (D106: Landlock/bubblewrap, Seatbelt, restricted token + job object); where no sandbox holds, every non-allowlisted command is approval-class unless the person grants "shell inside workspace" knowingly, and the UI says "not sandboxed on this system".

#### 4. Grants: scopes, lifetime, listing, revocation

| Scope | Bound to | Ends |
|---|---|---|
| `once` | one call: the **action hash** (capability, tool, canonical arguments, resolved targets, `cwd`, env names) | on use, or 10 min unused |
| `task` | the D36/D105 task id | task done or aborted, or 24 h |
| `session` | the 2c session id | session end or archive, or 7 days idle |
| `always` | *(person, agent)*, optionally a project | revocation; **auto-expires after 90 days unused**, with a review nudge in the inbox at 90 days of age (Q13) |

- `money.spend`, `os.privilege` and `pkg.change` are `once` only; `always` for anything `outsideRoots` with write access, for `net.publish public` and for `remote.control` needs a T3 surface.
- Grants are listed and revoked in **Settings › Permissions** (per agent: roots, path grants, capability classes, standing grants with last use and expiry) and in the `V2Approvals` rule editor (desktop spec §13: agent › project › global, *Test an action* runs the policy on a sample call without executing it); CLI `plur1bus grant list|show|revoke` and `plur1bus approval list|show|decide|audit` (every leaf `[experimental]`, `--json` schemas `grant.list/1` …, ADR-016); RPC `grant.list|create|revoke`, `approval.list|get|decide|cancel` and notifications `approval.requested`, `approval.resolved`, `grant.changed` (`x-server: "core"`, experimental). These methods are **refused for agent principals**, absent from every agent tool catalogue and the D103 index, refused as WebMCP tools (the `admin.*` rule, B15) and never exposed on the harness MCP server.
- **Revocation is immediate:** pending requests covered by the grant return to asking; a running call finishes its current syscall and the next call is re-decided; revoking a `remote.control` grant ends the session (D108 stop).

#### 5. The approval request flow

**Request contents** — computed by the harness, not written by the model, shown first:
- `capability`, `effect`, flags, the **exact** command line / path list / diff (unified, with byte counts) / URL and payload summary / package list;
- **risk** (`low`/`medium`/`high`/`critical`, from the table in §2 plus flags), **reversibility** (`reversible` via trash or snapshot, `irreversible`), and what undo exists;
- subject (agent, session, task), principal, the **provenance** of the turn (§8: "requested after reading content from example.com");
- the **grant options** the capability allows (§4), the narrowest one pre-selected;
- the action hash (short form shown, so what the person sees is what is bound);
- last, labelled *"the agent's reason (unverified)"*: the model's `why`.

**Surfaces and channel trust.** A request appears on every surface the person has on, is decided once (first valid answer wins, the others close), and a decision is accepted only when the surface is trusted for the request's class:

| Level | Surfaces | May decide |
|---|---|---|
| **T3** | desktop app (D1/D2); web UI with a fresh step-up (WebAuthn/TOTP within 5 min, ADR-004) for T3 classes; CLI on a TTY of the owning OS user (direct-chat spec §6 REPL, `plur1bus approval decide`) | everything decidable |
| **T2** | web UI session without step-up; a **private chat** with a **D24-linked** identity on a first-party channel module (Telegram, Discord, Matrix; D60) | `low`–`high`, not `money.spend`, `os.privilege`, `always` grants outside roots, `remote.control`, `net.publish public` |
| **T1** | the inbound ACP editor that started the session (D25, as `session/request_permission`) | `low` only (`fs.read`/`fs.write` inside a grant, `clipboard.read`) |
| **T0** | group chats, unlinked identities, MCP clients, A2A peers, other agents, model output, tool results, third-party channel modules unless the person opts that module into T2 | nothing |

- **Channel rendering:** Telegram inline keyboard, Discord components, Matrix reactions or a numbered reply the D21 router understands (`/approve <id>`); each button carries the request id and a **one-time nonce** bound to *(linked person, that private chat)* — the auftrag's user + chat + nonce rule. Where the full command or diff does not fit faithfully, the channel shows a summary with *"open in the app to decide"* and offers no approve button.
- **Timeouts and the absent person:** a foreground turn waits up to 10 min, then the task **parks** as *waiting for approval* (notification repeated once), and after 24 h the request **expires = denied** (`E_APPROVAL_REQUIRED` becomes `E_DENIED reason=approval-expired`). **Nothing is ever auto-approved** — not on timeout, not by a surface default, not by an MCP or ACP client's own "always allow" (D32). The agent receives a typed result with a `userAction` sentence (D94 style) and continues with work that does not need the approval.
- **Batching:** a plan (D106 dry run, a package list, a multi-file edit) is one request bound to the exact list; any deviation is a new request. Several pending requests of one task are grouped on one card (approve all / each).
- **Against approval fatigue:** one open prompt per agent per surface (the rest queue); at most 10 prompts per task per hour (Q15); a request identical to one denied in the same task is refused without asking; after the third similar request the card offers the narrowest standing grant that covers the pattern, or *stop this task*; every surface shows the count.

#### 6. The approval store

- **Where:** the core's SQLite store under `state/` (tables `approvals`, `grants`, `approval_events`), never in `config.json`; readable by the core only; `1staid repair` never touches it (ADR-012 §10.13).
- **Integrity:** an append-only event log; every row carries an **HMAC-SHA256 chain** value keyed by a per-installation key in the secret store (ADR-005), verified on every read of a grant and by `1staid check approvals.integrity` at start and daily; a broken chain suspends every grant after the break (fail closed) and shows which. Decisions that must be verified by another process — the `PLUR1BUS Host` helper (D107), a D108 controlled desktop — carry an **Ed25519 signature** by the harness's approval key, whose public half is pinned at pairing (D35).
- **Records:** request (all §5 fields, redacted), decision (`approve`/`deny`, scope, person, surface level, surface id, nonce, time), grant lifecycle (created, used, expired, revoked), with the action hash.
- **Replay protection:** every approval is bound to *(request id, action hash, principal, subject, session/task, nonce)*; `once` is single-use (consumed atomically with execution start); nonces are single-use and expire with the request; an approval presented with different arguments, another agent, another session or after expiry is refused (`E_DENIED reason=approval-mismatch|approval-used|approval-expired`).
- **Hand-offs reference, never mint (D104):** `authority.approvalsHeld` lists store ids. The receiver may use a referenced approval only if the person marked it **delegable** when deciding ("allow for this task, including helpers"), the action hash or path grant covers the receiver's call, the call is inside the hand-off's `constraints.scope`, and the task id matches. Anything else is a new request to the person. A forged or foreign id is refused and audited (D104 acceptance).
- **Remote control (refines D108):** approvals made on either end are recorded on the harness; the controlled desktop verifies the signature and its own per-harness scopes before acting, and for `high`/`critical` requests only a decision made **on the controlled machine** counts — a compromised remote harness cannot mint approvals for the desktop.
- **Not protected** (stated like extensions §8.8): code running as the person's OS user with write access to `state/` and the secret store can forge the chain; the store detects tampering by anything weaker, it does not stop malware with the person's rights.

#### 7. Enforcement point and the second layer

- **Where:** `policy.decide(principal, subject, call)` in the core's tool dispatcher — the one path every harness tool, MCP tool, plugin command, skill-script run, ACP `fs/*`/`terminal/*` callback and host-bridge call takes — after `authorize()` (ADR-007) and D97 validation, before execution. It returns `allow`, `ask(request)` or `deny(reason)`; typed results use the closed enum (`E_APPROVAL_REQUIRED`, `E_DENIED reason=policy-never|outside-roots|deny-list|approval-expired|approval-mismatch|surface-untrusted`). The model never sees a tool it may never call in its catalogue (D103), but a hidden tool is not the boundary — the dispatcher is.
- **Second layer:** the OS sandbox for `shell.exec` and skill scripts (D106), the helper's own per-capability switch and approval check on the host bridge (DS17, D107), the desktop's own scopes for D108.
- **Third-party MCP servers:** calls are gated per tool (effect from the manifest/`p1x.json`, raised by annotations, `external` when unknown); the server process itself runs as the OS user without a sandbox in v1 (extensions §3, §8.6), so D109 gates what the agent asks it to do, not what the server does on its own — the install dialog says so. Declared `filesystem`/`processes`/`network` capabilities set the server's floor: a server that declares `filesystem: home` gets every tool at least `approval` until the person lowers it.
- **Extension modules and channels:** tools they offer go through the dispatcher; their own code keeps full authority (module-guide §9). A channel module relays approval *answers*; the store accepts them only for the linked identity and chat the nonce was issued to, and only first-party channel modules are T2 by default.

#### 8. Untrusted content and prompt injection

- Tool results, web pages, files outside roots, other agents' returns, channel group messages, MCP/ACP/A2A payloads and screenshots are **data** (auftrag §11, D94 provenance envelope, D104). Text in them that claims an approval ("the user approved this") has no effect: approvals exist only as store records.
- **Taint:** a turn becomes `tainted` once untrusted content enters its context. Tainted requests show their sources on the card; if the turn has also read private data (memory `user` scope, files outside the workspace, PIM), **standing grants for `external`, `comm.send` and `net.publish` are suspended for that turn** and the call asks — the lethal-trifecta rule of ADR-011 made mechanical (Q18).
- The model cannot widen its scope: requests for a broader grant than the call needs are narrowed by the harness to the call's own targets; a request whose targets differ from the call it accompanies is refused.

#### 9. Headless runs, privilege, audit

- **Headless and unattended** (cron and recurring tasks, background jobs, M4 feature delivery, D108 unattended): a job runs under its owner's principal and may use **only standing grants created for that job** (`scope: always` with `job: <id>` and an optional expiry), shown on the job's settings page. Session and task grants of the person who created the job never carry over. An approval-class call without such a grant parks the job and notifies; it is never approved by the absence of an answer.
- **Privilege escalation** (refines D106): always `once`, T3, with the exact command. The harness never passes a password: `sudo -S`, `SUDO_ASKPASS`, `--stdin`, piped or here-doc passwords, `expect`, `runas /savecred`, stored credentials and `gsudo` caching are refused by the shell layer; agent PTYs never inherit a cached `sudo` timestamp (`timestamp_type=tty`; the harness runs `sudo -k` at session open). Elevation happens in the OS prompt on the person's screen — polkit/`pkexec` dialog, macOS Authorization Services through the helper, Windows UAC for a one-shot elevated child whose command line is the approved one; the harness process itself never runs elevated. Without a person at the screen, privilege is unavailable.
- **Audit** (ADR-004 audit list, D106 audit line): one line per request, decision, grant change, denial, sandbox violation and integrity failure — who, which agent, which surface and level, capability, targets, action hash, outcome. Redaction as ADR-005: secret-shaped values masked, file contents and tool results never logged, diffs as hash + size (the full diff stays in the session transcript, which follows the session's incognito and retention rules). Readable in `V2Approvals` › Audit and `plur1bus approval audit`; retained 400 days by default.

#### 10. Conflicts resolved

- **D62 vs D94/D96/D106:** D62 lets "credential-entry actions require approval"; D94, D96 and D106 say the agent never types passwords. D109: `credential.entry` is **never**; login is a D96 handover.
- **D106 table vs the owner's request:** D106's `fs` row says "read: allowed" without a roots qualifier. D109: read is allowed **inside roots and grants**; outside is approval (Q12).
- **D55 page-owned confirmation:** a WebMCP mutation confirmed only inside the page cannot be verified by the harness. D109: the page's confirmation is a rendering of a store request (`approval.decide` from that authenticated session), so the record exists server-side.
- **Effect vocabularies:** D103 `sideEffects`, extensions `tools[].effect` and ADR-008 `auto/ask/deny` are three encodings of one axis; §2 is the mapping, and X2's "tool-effect approval defaults" are the defaults of §2.
- **"D30 approvals"** in D55, DS17 and desktop spec §6/§13 is a mis-citation (D30 is model routing); read as D109.
- **ADR-003's monotonic merge vs grants:** grants widen narrowly per person and context, which ADR-003 said the merge cannot do. They are a separate, audited dimension that never overrides a behaviour-layer `tools.deny`, a `never` floor or the deny-list, so the merge stays monotonic.
- **D32's rejected `allow_once`:** that was the harness auto-answering an external agent's permission request; D109's `once` is a person's decision for one action hash.

#### 11. Tests and acceptance

1. **Conformance per OS** (the D106 suite's targets: macOS arm64, Linux x64/arm64, Windows x64/arm64, plus the owner's Windows 11 VM nightly), against a scratch home: a path fixture set per OS — symlink, junction and reparse point out of a root, a symlink swap between check and use (race harness), hard link to an outside file, 8.3 alias of a deny-listed file, ADS, trailing dot/space, reserved device names, case variants on case-sensitive and case-insensitive volumes, NFD names, `/private/var`, `\\?\` and UNC forms, `/proc/self/root`, bind mounts — every escape refused, every legitimate path inside a grant allowed.
2. **Grant lifecycle:** each scope expires on its bound; revoke mid-task stops the next call; grants survive a core restart; `always` auto-expires unused; job grants do not leak into sessions and vice versa.
3. **Store:** a tampered row breaks the chain → `1staid check approvals.integrity` fails and later grants are suspended; replay of a used `once`, reuse in another session, altered arguments under the same id, an expired nonce — all refused.
4. **Surface trust matrix:** a group chat, an unlinked identity, an MCP client's elicitation, a T1 editor on a `high` request and a T2 channel on `money.spend` are refused; a T3 decision passes; channel buttons with another chat's nonce are refused.
5. **Adversarial eval `permission-eval`** (a `tool-eval` suite, D97, recorded fixtures per PR, live nightly per default model): ≥ 40 scenarios — an injected web page or README asking to read `~/.ssh` or `.env`, to widen roots, to call a grant or approval method, to run `sudo -S`; a tool result claiming "approved"; a forged and a foreign `approvalsHeld` in a hand-off (D104); a delegable approval used outside its scope; a request whose shown targets differ from the executed ones; path obfuscation from item 1 through the model; an approval-fatigue loop. **Gate: zero policy escapes** (hard, every PR) and ≥ 95 % success on the benign twin of each scenario (no over-blocking), per shipped default model.
6. **Headless:** a cron job with no standing grant parks and notifies; with a job grant it runs; nothing is approved by timeout.
7. **Privilege:** the agent cannot supply a password by any listed route; the OS prompt appears with the approved command; no cached `sudo` timestamp reaches an agent PTY.

**Placement and effort:** **M1b-2b**, as the prerequisite of D106 (which lands in the same milestone and consumes it): policy engine, taxonomy, path canonicaliser, store with integrity and replay protection, `grant`/`approval` RPC and CLI, conformance and `permission-eval` — **6–9 ad** (policy + taxonomy + canonicaliser 3–4, store + RPC + CLI 2–3, tests and eval 1–2). The surfaces follow their milestones: in-turn approval with 2c/M2 (direct-chat CLI REPL, `turn.approval`), web inbox, Settings › Permissions and step-up with M3 (+1–2), channel buttons and nonces with M4 (+1), ACP permission mapping with M6 (in its existing line), MCP tool-effect defaults with X2 (in its line), helper verification with D2 and dual-end verification with D4 (+1). **Total +9–13 ad.** Until 2c exists there is no turn loop, so M1b-2b's approval path is `E_APPROVAL_REQUIRED` plus `plur1bus approval decide` and the harness MCP server's calls.

**Owner questions:** §4 Q12–Q19.

## 3. Placement and effort

| Decision | Milestone | Effort (ad) | Acceptance added |
|---|---|---|---|
| D94 `web.fetch` | **M2** | 5–8 | fixture corpus ≥ 60 pages, ≥ 95 % main-text retention, every typed failure produced by a fixture, SSRF suite |
| D95 `web.search` | **M2** | 2–3 | each provider against a recorded fixture; SearXNG live in nightly; `no-provider` path |
| D96 browser tools | **D3** (native panel + container); container-only subset with D74 b if earlier | 3–5 (D3 12–18 → 15–23) | `scroll untilStable` on an infinite-scroll and a virtualised-list fixture page returns every item once; handover round trip |
| D97 tool use | **M2** (validation, repair, dialects, results, catalogue) + nightly `tool-eval` from M2; **v0.1.0 gate** in M8 | 4–6 + 3–4 | invalid-argument repair test per wire format; `tool-eval` ≥ 95 % per default model |
| D98 coding gate | **M5** (worktrees); skills ship with D64's bundle | 3–5 | `task.complete` refused until checks ran; detection over five toolchains; override leaves a note |
| D99 two-horizon mining | with **D49** (2c session store + D36 tasks) | 2–3 | one-success and two-success fixtures; in-chat buttons on web/CLI and one channel; agent cannot accept its own proposal |
| D100 documents | **M6** (skills) with D65; golden set in CI from then; rubric in the v0.1.0 checklist | 6–10 | golden set visual diff; automatic page checks catch seeded overflow/contrast/widow defects |
| D101 installer | **D1** | 2–3 | per-channel checks: choices applied, silent flags, update keeps a deleted icon deleted, uninstall removes entries |
| D102 | record only | 0 | — |
| D103 capability index + category routing | **M2** with D97 (index, taxonomy, keyword/embedding tiers, `capabilities.search`); decision-model tier with the D18/D70 decision service | 4–6 | routing recall ≥ 95 % on `tool-eval`; new skill routable right after install; decision call ≤ 200 ms p95 locally; stable category prefix |
| D105 message triage | **M2** with D30 and D103 (one decision call) | 2–4 | segmentation F1 ≥ 0.9; under-provisioning ≤ 5 %; escalation one class up once; class change only at task boundaries |
| D106 host toolset | **M1b-2b** (tool execution under a principal) | 7–11 | per-OS conformance on five targets + Windows VM nightly; credential deny-list suite; approvals for every destructive/privileged call; host scenarios in `tool-eval` ≥ 95 % |
| D107 OS ecosystem layer | **D2** (signed `PLUR1BUS Host` helper over DS17) | 10–15 | per-OS ecosystem leg (owner's Mac per release, Windows VM nightly, GNOME + KDE VMs); just-in-time grants; no Input Monitoring; FDA reads approval-gated; typed route chosen before UI fallback |
| D108 remote desktop control | **D4** | 4–6 | desktop dials out to the person's own harness only; per-harness capability scopes; session consent on the controlled machine; indicator + stop; dual audit; two-machine test |
| D104 hand-off format | **M5** (replaces the typed delegation contract's field list; D36/D50 consume it) | 2–3 | schema validation and repair; `ack` round trip; `approvalsHeld` verified against the approval store; a forged approval reference is refused; Markdown rendering |
| D109 permission and approval model | **M1b-2b** (before D106); surfaces with M2, M3, M4, D2, D4 | 6–9 + 3–4 | per-OS path conformance (links, junctions, 8.3, ADS, case, NFD, races); grant lifecycle; store integrity and replay refusal; surface-trust matrix; `permission-eval` with zero escapes; headless parks without a job grant; no password route for the agent |

**Total +68–105 ad** across M1b-2b (+13–20: D106 7–11, D109 6–9), D2 (+10–15, D109 helper check inside), D4 (+5–7), M2 (+20–31), M3 (+1–2), M4 (+1), M5 (+5–8), M6 (+6–10), D1 (+2–3), D3 (+3–5), and D49's milestone (+2–3, not yet placed in `milestones.md`; D49 itself has no milestone row today).

## 4. Owner choices (defaults the design runs on)

| # | Question | Default | Recommendation |
|---|---|---|---|
| Q1 | Is `web.fetch` a v0.1.0 **gate** (not just shipped)? | yes | yes — owner called it "among the most important" |
| Q2 | Default `web.search` provider when nothing is configured | offer bundled SearXNG in setup | same; Brave as the no-self-hosting option |
| Q3 | One success enough for a proposal when repeatable? | yes, with the ≥ 3 steps / no correction rule | yes |
| Q4 | Accepted mined skill enabled right away? | yes | yes (the person just said "adopt") |
| Q5 | `task.complete` hard-refused without checks, or warn only? | refuse, override with note | refuse |
| Q6 | Tool-use bar for v0.1.0 | ≥ 95 % per default model | 95 % |
| Q7 | Fonts of the neutral kit | Inter / Source Serif 4 / JetBrains Mono | as default; brand kit overrides |
| Q8 | Windows opt-out flags for silent install | `/NODESKTOP /NOSTARTMENU /NOAUTOSTART` | as written |
| Q9 | Shortlist size and split rule (D103) | 12 items, proportional to the category probabilities | as written; tune on `tool-eval` |
| Q10 | Is the hand-off `ack` mandatory for every `delegate`? | yes, except `consult` and hand-offs under 1 k tokens of budget | yes |
| Q11 | Default cost preference for model classes (D105) | `balanced` (P(needs more) ≤ 0.2) | `balanced` |
| Q12 | Reading outside the agent's roots (D109 §2) | **approval** (grantable once/task/session/always) | approval — the owner's own example |
| Q13 | Lifetime of an `always` grant | until revoked; **auto-expires after 90 days unused**; review nudge at 90 days of age | as default |
| Q14 | May a person lift a credential deny-list entry for an agent? | **no** — existence probes only; the person handles such files themselves | no |
| Q15 | Approval timeouts and fatigue limits | 10 min in the foreground, parked up to 24 h, then **denied**; ≤ 10 prompts per task per hour; an identical denied request is not re-asked in the task | as default |
| Q16 | Channel trust: may a linked private Telegram/Discord/Matrix chat approve `high` requests (delete, send mail, run a non-allowlisted command)? | **yes (T2)**; money, privilege, `always` outside roots, public publishing and remote control only on T3 (app, CLI TTY, web with step-up) | as default |
| Q17 | "Shell inside workspace" on a system where no OS sandbox holds | offered, labelled **not sandboxed**, off by default | as default |
| Q18 | Suspend standing grants for external effects in a turn that read untrusted content and private data (D109 §8) | **yes** | yes |
| Q19 | Inbound ACP editor (Zed) as an approval surface | **T1**: low-risk only (reads, writes inside a grant) | as default |

## 5. Risks

- **R1 Extraction quality varies by site.** Mitigation: the fixture corpus, render fallback, typed failures, nightly drift report.
- **R2 Tool-eval pass rates differ strongly between models.** Mitigation: per-model quirks table, "limited tool use" label instead of hiding models.
- **R3 Visual review needs a vision model.** Mitigation: automatic checks always run; the delivery says when the model review was skipped.
- **R4 Proposal fatigue.** Mitigation: rate limits, *Never for this kind*, threshold tuning on fixtures.
- **R5 Autostart feels intrusive to some users.** Mitigation: visible first-run toggle everywhere, OS controls respected, no re-enable after a user's disable.
- **R6 Routing hides the right tool.** Mitigation: `capabilities.search` always present, low-confidence widening, misses counted and shown.
- **R7 Hand-offs grow into essays.** Mitigation: the 2 k cap enforced by validation, artefacts by reference.
- **R8 Approval fatigue turns approvals into click-through.** Mitigation: D109's per-task prompt cap, refusal of repeated denied requests, narrowest-grant suggestion, batching, `allowed` by default inside roots so prompts mean "outside the usual".
- **R9 Path canonicalisation misses an OS quirk.** Mitigation: deny-side case folding, identity checks after open, the per-OS fixture set, `permission-eval` gating every PR; the shell's boundary is the OS sandbox, not argument parsing.
