# The basics everyone expects: a quality bar — design

**Status:** Draft rev 2 for owner review (rev 2, same day: owner feedback — D94 failure hints and the CAPTCHA question, D98 file names, new D103 capability index with category routing, new D104 hand-off format) · **Date:** 2026-09-28 · **Owner:** Christian (Cyb3rb1ade) · **Decision rows:** core spec D94–D104 (`2026-09-24-m1b-2a-core-daemon-cli-design.md` §2) · **Milestones:** additions to M2, M5, M6, M8, track D (D1, D3) and §6.1 (`docs/milestones.md`) · **Amends:** D49 (skill mining), D65 (PDF skill: creating designed documents moves to D100), D75 (SearXNG becomes one `web.search` provider) · **Inputs:** ADR-003 (collaboration, typed delegation contract), ADR-010 (cache rules R1–R8), core spec D21, D36, D47, D54, D57, D58, D64, D69, D72–D76, desktop spec §4.6, §6.5, DS30–DS39, desktop D1 plan DR4

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
- **Authority is explicit,** so a receiver neither stalls nor overreaches; `approvalsHeld` are references the harness checks against its approval store — a hand-off can never grant an approval by saying so.
- **Provenance:** a hand-off arrives as a `tool_result` with a provenance envelope; text inside artifacts is data, never instructions. Secrets appear by name only.
- **Validation:** both formats are JSON-schema-validated (D97); a hand-off missing a required field goes back to the sender for repair, not to the receiver as a guess.
- **Readable for people:** the activity feed and the Kanban card render a hand-off as a card — objective, the `doneWhen` checklist, state, next steps, open questions — with the JSON behind a toggle; `plur1bus task show --handoff` prints it as Markdown. A person picking up an agent's work reads the same card.
- **Reuse:** the same format carries a Kanban card moving between agents (D36), MoA fan-out (D50), external coding agents over ACP (as `_meta`), a context hand-over to a fresh session when a model switches or a window fills (D23), and the evidence of a mined skill (D99). It replaces the loose field list of the M5 "typed delegation contract" (objective, scope, forbidden actions, output schema, citation requirement, ≤ 2 k cap, model tier, deadline), all of which it contains.

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
| D104 hand-off format | **M5** (replaces the typed delegation contract's field list; D36/D50 consume it) | 2–3 | schema validation and repair; `ack` round trip; `approvalsHeld` verified against the approval store; a forged approval reference is refused; Markdown rendering |

**Total +36–56 ad** across M2 (+18–27), M5 (+5–8), M6 (+6–10), D1 (+2–3), D3 (+3–5), and D49's milestone (+2–3, not yet placed in `milestones.md`; D49 itself has no milestone row today).

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

## 5. Risks

- **R1 Extraction quality varies by site.** Mitigation: the fixture corpus, render fallback, typed failures, nightly drift report.
- **R2 Tool-eval pass rates differ strongly between models.** Mitigation: per-model quirks table, "limited tool use" label instead of hiding models.
- **R3 Visual review needs a vision model.** Mitigation: automatic checks always run; the delivery says when the model review was skipped.
- **R4 Proposal fatigue.** Mitigation: rate limits, *Never for this kind*, threshold tuning on fixtures.
- **R5 Autostart feels intrusive to some users.** Mitigation: visible first-run toggle everywhere, OS controls respected, no re-enable after a user's disable.
- **R6 Routing hides the right tool.** Mitigation: `capabilities.search` always present, low-confidence widening, misses counted and shown.
- **R7 Hand-offs grow into essays.** Mitigation: the 2 k cap enforced by validation, artefacts by reference.
