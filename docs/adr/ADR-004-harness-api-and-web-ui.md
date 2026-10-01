# ADR-004: Harness API and web UI

**Status:** Accepted (2026-09-22) · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D1, D2, D6, D10 · `docs/phase0/auftrag-original-2026-09-21.md` §4, §5.1, §9, §11, §13 Q4 · `docs/phase0/research/openclaw-layout-dreaming-ui.md` §3 · `docs/phase0/research/plur1bus-host-contract.md` §7 · `docs/phase0/research/hermes-learnings-and-import.md` A13 · `docs/phase0/research/harness-engineering-state-of-the-art.md` §4, §7 · `docs/phase0/research/protocols-channels-coding-clis.md` (protocol table)

## Context

The original commission fixes the UI reference and leaves the delivery vehicle open: "Vorlage ist der PLUR1BUS-Tab der OpenClaw-Control-UI … Weg (ADR-004): (a) Hermes-Dashboard per Skin + Plugin-Seiten oder (b) eigene SPA über die Harness-API" (§9). It also fixes that multi-user operation and RBAC must live server-side in the harness API in either case, and that (b) is set if (a) cannot carry that.

Four forces decide this ADR.

1. **D1 removes option (a)'s substrate.** Variant B is the favourite: a single TypeScript monorepo, Node ≥ 24, pnpm; Variant A (Hermes as a pinned dependency) is only a counter-check in ADR-001 (`brief.md` D1). Hermes' dashboard is a React 19 + Vite 8 SPA that ships inside a Hermes installation (`research/hermes-learnings-and-import.md` A13, citing `web/package.json:2,35,55`). Under Variant B there is no Hermes installation, therefore no dashboard to skin and no plugin-page host. **Option (a) collapses; it is documented below only to show the counter-check was made.**
2. **The reference UI is source, not screenshots** (§9). PLUR1BUS's operator dashboard is a single server-rendered HTML document emitted by `lib/setup/control-ui-plugin-runtime.js` (1426 lines @ commit `89148f9`), mounted at `/plugins/memory-lancedb-namespaced/control` via `api.registerHttpRoute` (`control-ui-plugin-runtime.js:1403-1408`) and surfaced as a Control-UI tab descriptor `{surface:"tab", id:"plur1bus", label:"PLUR1BUS", …, requiredScopes:["operator.read"(,"operator.write")]}` (`:1394-1424`).
3. **The tab is an opaque iframe with hand-copied tokens — a live drift risk.** Verbatim comment at `control-ui-plugin-runtime.js:987-990`: *"The tab is an iframe with an opaque origin: it cannot read the host's stylesheet and receives no theme message. The Control UI tokens are copied here under their own names, dark first like the host, light on the OS setting."* The copied block (`:991-1013`) duplicates ~25 token values from OpenClaw's `ui/src/styles/base.css`. PLUR1BUS's own compatibility doc only asserts the values were "value-identical" between hosts 2026.8.2 and 2026.9.1 (`docs/compatibility-openclaw.md:306`), while the checked-out host is 2026.9.5 — i.e. the copy is verified one point release behind (`research/openclaw-layout-dreaming-ui.md` §3 Inferences). The harness owns its whole document, so it has no iframe and must have exactly **one** token source.
4. **The owner's UI critique of OpenClaw** (recorded in the commission context): the look is *too dense, cluttered, generic, and settings have no search*. The last point is verifiable: the control UI contains zero `type="search"` inputs and renders every setting as a `.setting-row` in one long page with only a sticky anchor bar `.jump` for navigation (`control-ui-plugin-runtime.js:538`, `:1060`). Density is likewise measurable: `body { font: 400 14px/1.55 }`, `main { max-width: 1180px }`, `.card { padding: 12px }`, `.grid { gap: 12px }`, `.badge { padding: 3px 10px; font-size: 12px }`, `dl { gap: 4px 12px; font-size: 13px }`, `.count-list li { padding: 3px 0 }`, `.skill-card dl { font-size: 12.5px }` (`:1015-1016, 1024-1039, 1111`).

## Decision

**Build an own single-page application served by, and talking only to, the harness API (option b).** The harness API is the single externally reachable surface: REST for resources, JSON-RPC 2.0 for engine/core operations, SSE for server→client streams and WebSocket only where the client must push. AuthN, RBAC, audit and rate limits are enforced server-side on every endpoint, deny by default; the CLI and the UI are peers, both thin clients. The UI keeps PLUR1BUS's card/badge/banner language and uses its **own Glow token system** (desktop spec §13.1; amendment 2026-10-01); the theme follows the OS with dark as the fallback. No OpenClaw-derived code or tokens are used in the web UI or the desktop shell. Owner-authorised deviations from the original reference: a comfortable density default, a settings search, and the word mark (now the morph wordmark, amendment 2026-10-01).

### Harness API

| Aspect | Decision | Source / rationale |
|---|---|---|
| Surface | One HTTP server. `/api/v1/**` REST, `/rpc` JSON-RPC 2.0, `/events` SSE, `/ws` WebSocket, `/mcp` (Streamable HTTP), `/a2a/<agent>/…` + `/.well-known/agent-card.json` per agent, `/` SPA. | §4 ("die Harness-API ist die einzige nach außen erreichbare Komponente"), §8; ADR-008 owns the protocol detail |
| Binding | Loopback by default; remote access documented via reverse proxy/VPN or built-in TLS. **Amended 2026-10-02 (C8):** exposure `remote.publish` = `local \| tailnet \| network`, default `tailnet`; the OS-level listener stays on loopback for `local` and `tailnet` (tsnet is userspace, `tailscale serve` proxies to loopback); `network` adds a TLS-only listener on the chosen interface with built-in TLS, self-signed by default and pinned by clients through the pairing payload, or a company CA; the API is never published to the internet (desktop spec §6.2). No other open TCP port; core IPC over Unix socket / Windows named pipe with token. **Caveat:** the PLUR1BUS engine's embedding-owner election binds a loopback TCP port on every non-Linux platform today — ADR-001 conflict C1 records this and its resolution (in-process owner on the harness path), which this row depends on. | §4, §9; ADR-001 C1 |
| Wire split | REST for CRUD and lists (cacheable, easy RBAC per route); JSON-RPC for core/engine calls that already speak JSON-RPC internally (recall, re-embedding plan/apply, feature runs), avoiding a second hand-written translation layer. | §4 IPC is JSON-RPC 2.0; PLUR1BUS already exposes gateway methods in that shape (`plur1bus.reembedding.{plan,apply,resume,rollback,status,switch}`, `research/plur1bus-host-contract.md` §7) |
| Streams | **SSE** for token streams, job progress, dreaming phase events, log tails — one direction, proxy-friendly, reconnects with `Last-Event-ID`. **WebSocket** only for PTY/terminal and interactive approvals. | Keeps the common path simple; MCP itself standardised on request-scoped SSE over Streamable HTTP (`research/protocols-channels-coding-clis.md`, MCP row) |
| AuthN | Session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` when TLS) for the UI; personal API tokens with scopes for CLI/automation; local accounts Argon2id, optional OIDC, TOTP/WebAuthn 2FA; owner bootstrap via a one-time token printed by installer/console. | §5.1 |
| AuthZ | RBAC (Owner/Admin/Operator/Member/Viewer) plus object rights per agent and project, enforced in one policy layer in front of every handler, deny by default — for UI, CLI, API tokens, MCP and A2A endpoints and channels alike. | §5.1; role set itself is ADR-007 / Q5 |
| CSRF | One-time token per write, bound to the session. PLUR1BUS's control UI already uses this shape (`CONTROL_UI_FORM_TOKEN_FIELD` hidden field on every write form, `control-ui-plugin-runtime.js:139-140`). | §9 |
| CSP | `default-src 'self'; script-src 'self' 'nonce-<per-response>'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. No inline script without nonce; no remote origins, fonts bundled locally. | §9 |
| Secrets | Never serialised into an API response, a log line, a browser payload or an export; the UI shows status and last-4/fingerprint only. Secret writes are Owner/Admin only. | §9, §11; detail in ADR-005 |
| Rate limits | Per identity and per route class (auth, write, expensive/model-backed), plus a global concurrency cap for model-backed operations. | §5.1, §9 |
| Audit | Every login, config change, CRUD on agents/users, approval, share, model change, licence confirmation, break-glass and import. Structured logs with secret redaction. | §11 |
| CLI | `plur1bus-harness` is a thin client: local IPC to the core when on the same host, the harness API when remote. `--help` and trivial subcommands must not load the API/engine bundle (D6: < 100 ms cold start, lazy `import()` for every heavy dependency). | D6; `research/harness-engineering-state-of-the-art.md` §4 rule "no network call and no subprocess spawn on the prompt-build path" |

### Web UI — framework

Requirements: small shipped bundle, friendly to contributors without a build step, WCAG 2.1 AA, full keyboard operation, i18n de/en, dense data tables and many forms, one maintainer.

| Dimension | Option A: Preact + Signals (TS, esbuild bundle) | Option B: Lit 3 web components |
|---|---|---|
| Complexity | Low — familiar component model, `preact/compat` opens the React component ecosystem where an accessible primitive is worth reusing | Low–Medium — standards-based, but every shared behaviour (focus trap, listbox, live region) is hand-written |
| No-build friendliness | Needs a build for JSX; `htm` tagged templates give a no-build fallback for patching a running install | Best — plain ESM + an import map runs unbuilt; a build is still wanted for i18n extraction, hashing and nonce injection |
| a11y | Plain light-DOM markup; standard ARIA patterns apply unchanged | Shadow DOM complicates global focus management and `aria-*` references across roots (mitigable with a light-DOM render root) |
| Theming with CSS custom properties | Direct | Direct — custom properties pierce shadow boundaries |
| i18n de/en | Message catalogue + `Intl`; no framework coupling | Same |
| Bundle size | Both are in the "few kB core" class; **neither number is verified in this phase** | Same caveat |
| Maintenance burden | Larger third-party surface, but more ready-made accessible parts | Zero framework churn risk; more code to own |

**Recommendation: Option A (Preact + Signals, TypeScript, bundled with esbuild), with Lit as the named fallback.** Reasoning: the harness UI is form- and table-heavy, where reusing audited accessible primitives beats re-implementing them; the density and settings-search work is layout work, not framework work; and a build step is unavoidable anyway for CSP nonces, subresource hashing and i18n extraction, which removes Lit's main advantage. **This is not yet evidence-backed** — bundle size, axe-core AA results and keyboard traversal must be measured in a two-day spike before M3 (see Open questions and Action items).

Rejected without a spike: React/Next and any framework requiring a server runtime for rendering (contradicts "no cloud component", §1 Nicht-Ziele, and inflates the bundle); Electron/Tauri shells (no desktop client is in scope for v0.1; Hermes' two-shell split is noted in `research/hermes-learnings-and-import.md` A14 as double release/signing cost).

### Pages (from §9), with Memory as the main area

| Area | Page | Content |
|---|---|---|
| **Memory (main)** | Health · Cards by agent/workspace/user · Search with explain · Reviews & critical push · Conflicts · Migration · Compact | §9; ACL scopes per `research/plur1bus-crons-embedding-portability.md` §3 |
| | **Dreaming** (sub-area, owned by ADR-009) | Per-phase status (light/REM/deep), enable switch, schedule, last/next run, duration, outcome counts, per-run log, "run now", visible error state, dream diary reader | brief D4 |
| **Models** | Catalogue · Assignment by purpose and store · Embedding planner · Model preparation · Compatibility probe · Calibration · Benchmark · RAM budget | §6.2; detail in ADR-006 |
| Agents | CRUD, detail, access rights, runtime/sessions/logs/usage/health | §5 |
| Users & roles | Accounts, roles, object rights, pairing codes, break-glass log | §5.1 / ADR-007 |
| My area | Own memories, linked channel identities, API tokens, 2FA | §5.1 |
| Providers & logins | Provider profiles, device-code dialog, login status (valid until, plan/tier, last error), **policy status badge** | §6.3 / ADR-005 |
| Channels & bot connections | Telegram, Discord, Matrix, Buzz; allowlists, DM pairing, connection test | §8 |
| Projects & collaboration | Board, notes, workspace pool, members, budget, **collaboration trace** (who asked whom, cost, result) | §7 |
| Skills | Install from hub/git/local, preview before activation, versions, proposal queue | §8 |
| Plugins | Source/version pinning, permission display before activation, per-agent disable | §8 |
| MCP / ACP / A2A | Client servers + allowlists + tool approval; own MCP server; A2A opt-in per agent, remote agent registry, trust level | §8 / ADR-008 |
| Cron | Feature crons and user jobs, delivery targets, run ledger | brief D4 / ADR-009 |
| Import | OpenClaw / Hermes wizard, dry-run report, resume | §4.2 |
| Sessions / Logs / Audit | Session list and replay, structured logs, audit trail | §11 |
| **Settings / Secrets** | Grouped settings **with a search box across labels, keys, help text and current values** (values redacted for secrets); secret entries Owner/Admin only | §9 + owner critique |
| Doctor | Readiness table, probes, repair actions | §9 |

**Visibility by role** (deny by default; a page not listed is not rendered *and* its endpoints reject):

| Page group | Owner | Admin | Operator | Member | Viewer |
|---|---|---|---|---|---|
| Memory (own `user` scope) | ✔ | ✔ | ✔ | ✔ | ✔ (read) |
| Memory (other users' `user` scope) | break-glass | break-glass | – | – | – |
| Dreaming, Cron, Sessions/Logs | ✔ | ✔ | ✔ | – | read |
| Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A | ✔ | ✔ | read | – | read |
| Agents CRUD | ✔ | ✔ | – | use only | read |
| Users & roles | ✔ | ✔ | – | – | – |
| Settings / Secrets | ✔ | ✔ (no secret reveal) | – | – | – |
| Import, Doctor | ✔ | ✔ | Doctor only | – | – |
| My area, Projects | ✔ | ✔ | ✔ | ✔ | read |

### First-run wizard

**Amended 2026-10-02 (owner, desktop spec §13.5 C12; canvas `V2Setup*`):** *Your account* (owner bootstrap with the one-time token from installer or console; native and VPS installations only — the desktop app's installer creates the owner of a bundled harness) → *Name & persona* (the first agent) → *Main model* (the first provider login) → *Switchboard* (channels) → *Memory* (**embedding and reranker choice with licence notice and model preparation**; the licence filter sits inside this step) → *Backups* → optional *Import* from OpenClaw/Hermes (§9, §10): 7 steps native/VPS, 6 bundled. *Superseded order (2026-09-22):* owner bootstrap → embedding/reranker with licence notice → first provider login → first agent → first channel → optional import. Each step is resumable and re-runnable later from Settings; the wizard writes an audit entry per completed step, and the licence confirmation records who, when and which licence (§6.2).

### Theme and reference screens

- **Tokens.** One own token system, **Glow**, with the values of desktop spec §13.1: paper `#F5F4F1`, ink `#16161A`, red `#E5484D`, the duo identity palette, the status pairs, and the dark shell token set; type Atkinson Hyperlegible Next, Lilita One (wordmark) and JetBrains Mono. The M3 theme file / `tokens.css` is generated from §13.1 and is the only token source. No OpenClaw Control-UI tokens, no `--oc-*` bridge and no OpenClaw accent (owner, 2026-10-01; the original 2026-09-22 text adopted OpenClaw's `base.css` values through the `--oc-*` bridge of `carapace-control-ui.css` — superseded and removed).
- **Attribution.** No theme or UI file is derived from OpenClaw, so no OpenClaw MIT header is carried (the 2026-09-22 requirement to reproduce the `carapace-control-ui.css` header is superseded and removed, owner 2026-10-01). Third-party fonts and other assets keep their own licence notices.
- **Theme follows the OS, dark as the fallback.** The theme is set from `prefers-color-scheme`; dark applies when the OS states no preference; an explicit three-state user override (system/light/dark) wins. Light and dark are both first-class (amendment 2026-10-01; the 2026-09-22 text mirrored OpenClaw's dark default — superseded).
- **Kept from the PLUR1BUS tab:** card surfaces (`.card`), pill status badges with semantic colour mapping (`.badge-ready|degraded|failed|…`, `control-ui-plugin-runtime.js:1031-1037`), readiness tables, banner feedback (`.notice`, `.notice-pending`, `.notice-result`, `:1028-1029, 1072, 1134`) — as patterns, restyled with the Glow tokens.
- **Density fixes (the owner-authorised deviation).** A `data-density` attribute with `comfortable` (default) and `compact`, driving one own spacing scale of 4/8/12/16 px: card padding 12px → 16px comfortable; grid/section gap 12px → 16–20px; badge padding 3px 10px → 4px 10px with a 12px minimum font size; definition lists 13px → 14px with `line-height ≥ 1.5`; no text below 12px anywhere; `main` max-width 1180px → a measure-limited 72ch for prose columns while tables stay full width; the single long page replaced by routed pages with a real navigation rail instead of the sticky `.jump` anchor bar.
- **Settings search (the second deviation).** A persistent search field over the settings index (label, config key, help text, current non-secret value, page), keyboard-reachable with `/`, results grouped by page, with deep links. Same index powers a global command palette (⌘K/Ctrl-K) later.
- **How reference screens are produced.** §9: the source is the reference, there are no delivered screenshots. Procedure: (1) ship the **logo package first**, per the owner's earlier decision; (2) render PLUR1BUS's control UI locally against fixture data (the renderer is a pure HTML emitter — `control-ui-plugin-runtime.js` — so a fixture projection plus a headless screenshot is sufficient, no OpenClaw host needed); (3) store those images as `docs/ui/reference/*.png` with the fixture that produced them; (4) draw the harness screens against them; (5) keep a visual-diff check so a token or density change is visible in review.

**Amendment 2026-09-27 (spec D74).** An optional **desktop shell** (Tauri with `tauri-apps/cef-rs`) is added as a client after M3. It hosts the same SPA plus a collapsible side panel with a CEF browser that can be detached into its own window and re-attached. The SPA stays the only required UI: without the shell (VPS, plain browser) the panel streams a headless Chromium. Enforcement is unchanged: the shell is a client of the harness API like the SPA, and it never gets its own policy layer.

**Amendment 2026-09-28 (design canvas, responsive rules; no decision changed).** The owner's canvas (https://claude.ai/artifact/CRjk86mofQ9vqhb2twu8wS) adds a page `v2 · Desktop & responsive` (now on page `v3 · Glow`, 2026-10-01) whose `RspRules` board is recorded as **binding** for this SPA in desktop spec §13.7: breakpoints by content width in CSS px (compact < 1024, normal 1024–1600, wide > 1600), minimum window 800 × 600, compact working down to 400 CSS px (200 % text zoom), per-pattern layouts, the collapse order, maximum widths (reading ≤ 72ch as in the density fix above, transcript ≤ 820, settings content ≤ 880, dialogs ≤ 680), sidebar full 256 / rail 64 / overlay 288, sheets 360, inline SVG icons and 1×/2×/3× rasters. It agrees with this ADR's density fix ("no text below 12px anywhere" — the redrawn boards now comply, desktop spec §13.5 C3) and adds a 44 px target size whose scope outside compact was open (C22; decided 2026-10-02: web UI ≥ 44 px in compact, ≥ 24 px at normal and wide per WCAG 2.2 SC 2.5.8 AA; native app windows ≥ 44 px). The ⌘K palette foreseen under *Settings search* is drawn as `V2Search`, which also searches agents, channels, memories, tasks and actions — that part is new scope (desktop spec §13.3 B11). The canvas's token source (C1), default theme (C2, and no theme control drawn) and wordmark morph (C4, now also on the desktop shell windows) still conflict with *Theme and reference screens* above and wait for the owner. *(Superseded: decided 2026-10-01, below.)*

**Amendment 2026-10-01 (owner decisions C1, C2, C4; independence from OpenClaw).** The three conflicts left open on 2026-09-28 are decided (desktop spec §13.5). The owner also stated: *"Nothing comes from OpenClaw. We are independent of OpenClaw; the only remaining relation is our plugin that attaches OpenClaw to the harness / the new PLUR1BUS."* Every OpenClaw-derived UI dependency is therefore removed from this ADR, not only overridden: the OpenClaw Control-UI tokens, the `--oc-*` bridge, the OpenClaw accent, the MIT attribution header for OpenClaw-derived theme files, and the `--oc-*` theme of action item 3. *Decision*, *Theme and reference screens*, *Consequences*, *Conflicts with the brief* and the action items are rewritten accordingly; the *Context* keeps the 2026-09-22 analysis of the PLUR1BUS tab as history. The OpenClaw plugin that attaches OpenClaw to the harness is unaffected.

- **Token source (C1, reading 1).** The owner's Glow system is the only token source. The values are those of desktop spec §13.1: paper `#F5F4F1`, ink `#16161A`, red `#E5484D`, the duo identity palette; type Atkinson Hyperlegible Next, Lilita One and JetBrains Mono. The M3 theme file / `tokens.css` is generated from §13.1 and stays the only token source. The `--oc-*` semantic bridge, the OpenClaw accent (`#ff5c5c` dark, `#bd4531` light) and the OpenClaw MIT theme header are removed; the web UI and the desktop shell contain no OpenClaw-derived code or tokens.
- **Default theme (C2).** The theme follows the OS (`prefers-color-scheme`); dark is the fallback when the OS gives no preference; the three-state override (system/light/dark) stays. Light and dark are both first-class; a canvas board drawn only in light is the light variant. This replaces "dark default, light per OS".
- **Word mark (C4, reading 1).** Deviation 4 is extended from the static word mark "PLUR1BUS Harness" to the morph wordmark as drawn (`V2LogoMorph`): the current section name in capitals with the red pivot `1`; Home shows "PLUR1BUS" with "Harness" below. It is isolated in one component, used by the SPA sidebar and the desktop shell windows.
- **Brand mark.** The red Lilita One "1" (`#E5484D`) is the brand core. The tray icon, the macOS menu-bar icon and every icon below 48 px use the red "1" alone (state shown by a badge shape on tray icons); the app icon from 48 px up uses "P1B" — P and B light on the dark plate inside the duo ring, the 1 red (desktop spec §13.8).

**Amendment 2026-10-02 (owner decisions C8, C9, C12; desktop spec §13.5).** *Binding* (C8): three exposure levels for the API, `remote.publish` = `local | tailnet | network`, default `tailnet`; `network` is for organisations without Tailscale (MPLS, VPN), TLS mandatory, self-signed by default with the fingerprint carried in the pairing payload so every client pins it without a manual check, or a company CA; optional client-subnet allow-list; pairing for every device; a security notice on enabling and `1staid check` `warn`; never public — public sharing stays per item for outputs (D72, `outputs.publicSharing`). Open question 3 is answered. *Pages* (C9): *Devices & Remote* drops the per-row *Switch* of the harnesses the app can open; one *Manage in the app* hands over to the desktop app's *Connections* page. *First-run wizard* (C12): the canvas order, with *Your account* first on native and VPS installations; rewritten above.

## Options considered

### Option A: Skin + plugin pages on the Hermes dashboard
| Dimension | Assessment |
|---|---|
| Complexity | N/A — no substrate under D1 |
| Fit with brief D1–D11 | **Fails D1/D2.** Requires a Hermes installation; Variant B has none |
| Cross-platform risk | Would add a Python runtime to every target (§10, K3 risk) |
| Maintenance burden | Upstream React 19/Vite 8 SPA we do not control (`hermes-learnings` A13); §9 forbids rewriting the Hermes frontend in a fork |
| Latency / token cost | n/a |

**Pros:** would inherit an existing dashboard for free under Variant A. **Cons:** does not exist under Variant B; RBAC would have to be retrofitted in front of someone else's frontend (the §2.2 kill criterion K4 anticipates exactly this).

### Option B: Own SPA over the harness API — **recommended**
| Dimension | Assessment |
|---|---|
| Complexity | Medium — a real frontend to build and maintain |
| Fit with brief D1–D11 | Full: server-side RBAC (D-agnostic, §5.1), Memory as main area, dreaming surface for D4, model surface for D9 |
| Cross-platform risk | None beyond the API host itself — static assets |
| Maintenance burden | Ours end to end; offset by owning the density/search/a11y outcome |
| Latency / token cost | Static bundle, cacheable; no model cost. CLI remains the fast path for D6 |

**Pros:** one auth/RBAC/audit layer for UI, CLI, API tokens, MCP and A2A; no iframe, therefore one token source and no hand-copied drift; the owner's density and search requirements are implementable. **Cons:** all frontend work is ours, including a11y and i18n; the first UI milestone (M3) is later than a skin would have been.

### Option C: Server-rendered HTML like PLUR1BUS's own control UI
| Dimension | Assessment |
|---|---|
| Complexity | Lowest |
| Fit with brief | Partial — §9 demands responsive, keyboard-operable, WCAG 2.1 AA, i18n de/en; achievable, but streaming (dreaming progress, token streams, log tails) and a command palette fight the model |
| Maintenance burden | Low initially, high once interactivity accretes (the 1426-line emitter at `control-ui-plugin-runtime.js` is the cautionary case) |

**Pros:** trivially CSP-clean, no build. **Cons:** SSE-driven live surfaces and the settings search/palette are the core of the owner's critique; retro-fitting them turns this into option B with worse foundations.

## Trade-off analysis

The decisive factor is not rendering technology but **where enforcement lives**. §5.1 requires deny-by-default RBAC server-side for UI, CLI, tokens, MCP, A2A and channels alike; only a single owned API delivers that once instead of five times. Once that API exists, the marginal cost of an own SPA over a skin is frontend labour, and the marginal benefit is every point of the owner's critique plus removal of the iframe/hand-copied-token drift class (`control-ui-plugin-runtime.js:987-990`). The framework question is genuinely open and cheap to settle empirically; the API shape is expensive to change later and is therefore decided now. Keeping the CLI a first-class client of the same core (not of the UI's API only) is what preserves D6: a long-lived core with thin clients is the pattern the state-of-the-art note ranks second of fifteen (`research/harness-engineering-state-of-the-art.md` §4, rule 2).

## Consequences

- **Easier:** one place to enforce authN/RBAC/audit/rate limits; one own design-token source (Glow, desktop spec §13.1) with no OpenClaw dependency; live surfaces (dreaming phases, migration progress, log tails) over SSE; the settings search and command palette; a11y and i18n owned rather than inherited; the reference-image pipeline doubles as a visual regression test.
- **Harder:** we now own a frontend — accessibility audits, keyboard maps, two locales, and a browser build in CI on top of the five-target native matrix; M3 grows; every new backend capability needs a UI surface or is invisible; CSP with nonces forbids convenient inline scripting and third-party widgets; the density deviation means the harness no longer looks pixel-identical to the PLUR1BUS tab, so "does it still look like PLUR1BUS?" becomes a review question rather than a diff.
- **Revisit when:** ADR-001 overturns D1 in favour of Variant A (then option A returns as a real candidate); the framework spike contradicts the recommendation. (The 2026-09-22 trigger "OpenClaw changes its token names" no longer applies: no OpenClaw tokens are used, amendment 2026-10-01.)

## Conflicts with the brief

**Finding.** §9 states: *"Keine gewollten Abweichungen außer Wortmarke ‚PLUR1BUS Harness'."* The owner's later critique of the OpenClaw look ("too dense, cluttered, generic, no search in settings") requires intended deviations: a comfortable density default, routed pages instead of one long anchored page, and a settings search.

**Source.** §9 (original commission, 2026-09-21) vs. the owner's UI critique recorded with the 2026-09-22 decisions; `brief.md` §1 establishes that the 2026-09-22 decisions supersede the original where they disagree. Measured basis for the critique: `control-ui-plugin-runtime.js:1015-1016, 1024-1039, 1060, 1111` and the absence of any `type="search"` input in that file (commit `89148f9`).

**Options.** (i) Follow §9 literally and ship a pixel-faithful copy, deferring density and search to a later version. (ii) Treat the critique as superseding §9 and allow an **enumerated, closed** list of deviations. (iii) Ship both: faithful "classic" theme plus a "comfortable" theme, user-switchable.

**Recommended resolution: (ii), with the deviation list frozen here** — (1) density scale and `data-density` switch, (2) routed navigation instead of the single long page, (3) settings search and command palette, (4) word mark "PLUR1BUS Harness" (extended to the morph wordmark, amendment 2026-10-01). Card/badge/banner patterns and readiness tables are kept as patterns; token values and the theme default are no longer copied from OpenClaw but come from the own Glow system with the theme following the OS (amendment 2026-10-01; the 2026-09-22 text copied OpenClaw's token values and dark default — superseded). Any further deviation needs a new ADR. Option (iii) is rejected as double maintenance of a look the owner has already rejected.

## Open questions for the owner

1. **Framework:** confirm Preact+Signals after the spike, or prefer Lit (no-build purity) — decision needed before M3.
2. **Density default:** `comfortable` as shipped default with `compact` available, or the reverse for power users?
3. ~~**Remote access in v0.1:** document reverse-proxy/VPN only, or also ship built-in TLS with certificate management? (§9 allows both.)~~ **Answered 2026-10-02 (owner, C8):** built-in TLS ships — `remote.publish` = `network` with `remote.tls` = `self-signed` (default; the harness generates the certificate, clients pin it through the pairing payload) or `company-ca`; `tailnet` (Tailscale) is the default exposure; see *Binding* and the desktop spec §6.2.
4. **Q4 (§13):** one bot connection serving several agents via mention/command routing affects the Channels page's information architecture. The default in `docs/assumptions.md` Q4 is "one agent, many bot connections" for M4, with mention-routing to several agents no earlier than M6 (ADR-003 §"Answer to open question Q4") — confirm, so the page is designed once.
5. Does the logo package (owner's earlier decision, produced first) also fix the favicon/monochrome/dark variants the UI needs, or is that a separate deliverable?

## Action items

1. [ ] Two-day framework spike: build the Models page twice (Preact, Lit); measure gzipped bundle, first paint on a cold cache, axe-core 2.1 AA violations, full keyboard traversal; record in `docs/ui/framework-spike.md`.
2. [ ] Freeze the harness-API surface map (routes × method × required scope × rate-limit class) as `docs/api-surface.md`; every later endpoint is added there first.
3. [ ] Generate the theme: one `tokens.css` / theme file from desktop spec §13.1 (Glow, light and dark, theme following the OS with dark as the fallback and a system/light/dark override) plus the harness density scale. No OpenClaw-derived tokens; no second copy anywhere.
4. [ ] Build the reference-image pipeline: fixture projection → headless render of `control-ui-plugin-runtime.js` output → `docs/ui/reference/*.png`, checked into the repo with the fixture.
5. [ ] Ship the logo package (word mark, app icon, favicon set, light/dark variants) before the first screen is drawn.
6. [ ] Specify the settings index schema (key, label de/en, help de/en, page, role, sensitivity) — it is the single source for the settings page, the search, the CLI `config` command and the wizard.
7. [ ] Write the a11y acceptance checklist (focus order, visible focus ring from the Glow tokens, live regions for SSE updates, 4.5:1 minimum on both themes) into `tests/` as an automated gate, not a manual step.
8. [ ] Confirm with ADR-008 that `/mcp`, `/a2a/**` and `/.well-known/agent-card.json` mount under this API and inherit its auth, RBAC and rate limits.
