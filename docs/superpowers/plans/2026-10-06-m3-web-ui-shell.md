# M3 Web UI Spike: Shell, Theme, Login Implementation Plan

**Goal.** Lay the M3 UI foundation as a new package `packages/web` (`@plur1bus/web`): a static, CSP-strict single-page
app with the app shell (sidebar *Workspace · Build · Control*, routing), a light/dark theme from the Glow tokens,
responsive layout (compact / normal / wide), a de/en i18n frame, and a login page against the `/api/v1` session
endpoints behind an interface, tested against a mock server (the real API is being built in parallel by another task).

**Authorities.** ADR-004 (§"Web UI — framework", §"Theme and reference screens", CSP row), desktop spec
`docs/superpowers/specs/2026-09-27-desktop-app-design.md` §13.1 (Glow tokens, `V2Sidebar`), §13.7 (responsive rules),
`docs/milestones.md` M3 (scope bullets "Web UI skeleton", "Responsive layout"; acceptance 7 and 9).

**Out of scope.** Real pages (Chat, Memory, …: shell placeholders only), the real API, first-run wizard, ⌘K search,
SSE, personal API tokens, TOTP/WebAuthn/OIDC. No file under `apps/desktop/**`, `.github/workflows/**`, or the other
hands-off paths is touched.

## 1. Framework spike (ADR-004 action item 1, scaled to this task)

Both candidates were built as the same minimal slice (nav + login form with two controlled inputs and a derived label),
bundled with the repo's esbuild (`--minify --format=esm --target=es2022`), measured 2026-10-06.

| Dimension | Preact 10.29 + `@preact/signals` 2.11 | Lit 3.3 |
|---|---|---|
| JS bundle for the slice (min / gzip) | 20.9 kB / **8.2 kB** | 15.2 kB / **5.9 kB** |
| Delta | +2.3 kB gzip over Lit; both far inside a 25 kB gzip budget | baseline |
| Strict CSP (`script-src 'self'`, `style-src 'self'`, no inline) | Clean: JSX/`h` build to JS, `style` objects are set through CSSOM, no `eval` | Clean in light-DOM mode (global stylesheet); the default shadow-DOM mode needs `adoptedStyleSheets` (also CSP-clean) |
| a11y | Light-DOM markup; `label for`, `aria-labelledby`, `aria-describedby` work across the whole page, axe sees one tree | Shadow DOM breaks ID references across roots (`label for` to a field in another root); only avoidable by rendering into the light DOM, which discards Lit's encapsulation |
| Fit to "form- and table-heavy, one maintainer" | Reusable accessible primitives (`preact/compat` opens that ecosystem); signals give shared state (session, theme, language, route) with no store code | Every shared behaviour (focus trap, listbox, live region) is hand-written; state is per element |
| Type checking in this repo | Plain `.ts` with `h()`: no JSX transform in `tsc`, so the root `tsconfig.base.json` (`erasableSyntaxOnly`) covers it unchanged | Decorators are not erasable; the `static properties` form works |

**RULING (ADR-004 Q1): Preact + Signals, TypeScript, esbuild, authored with `h()` in `.ts` files (no JSX).** Reasons: the
2.3 kB gzip difference is immaterial against the budget; the a11y finding is decisive because Lit's only way to keep
`label for`/ARIA references valid is to turn off its encapsulation; shared reactive state is the shell's main
cross-cutting need; and it matches the ADR recommendation, now backed by a measurement. Lit stays the named fallback.
Lit is therefore **not** a dependency of the package (the spike used a throwaway entry, not committed); the numbers live
in `docs/ui/framework-spike.md`.

## 2. Design

```
packages/web/
  package.json            @plur1bus/web (private); deps preact, @preact/signals; dev: esbuild, playwright, axe-core
  build.mjs               esbuild -> dist/{index.html,main.js,main.css}; exported build(outdir) for the tests
  index.html              static, no inline script/style, <link> + <script type=module src>
  src/
    main.ts               mounts the app
    app.ts                shell layout, route outlet, auth gate
    router.ts             hash router (signal): route table, navigate(), isKnown
    nav.ts                navigation model: groups Workspace/Build/Control, items, bottom Settings/Help
    icons.ts              inline SVG icons (stroke 1.75)
    i18n.ts               de/en catalogue, language signal (system | en | de), t(), Intl
    theme.ts              theme signal (system | light | dark), applies data-theme on <html>
    prefs.ts              guarded localStorage (try/catch, in-memory fallback)
    session.ts            SessionApi interface, types, HttpSessionApi, session state signals
    pages/login.ts, pages/placeholder.ts, pages/not-found.ts
    components/{sidebar,topbar,sheet}.ts
    styles/tokens.css     Glow tokens (§13.1), light + dark, density
    styles/app.css        layout, components, breakpoints
  test/
    mock-server.ts        node:http server: static dist + CSP header + mock /api/v1/auth/*
    harness.ts            builds dist to a temp dir, starts mock, launches Chromium, helpers
    build.test.ts  session-api.test.ts  e2e.test.ts  a11y.test.ts  responsive.test.ts
    fixtures/responsive.json   committed structural snapshots
docs/ui/framework-spike.md   spike table + bundle size report
docs/ui/web-shell.md         what the package is, how to run/test, route and API tables, rulings
```

**Shell.** Sidebar per `V2Sidebar`: wordmark; groups *Workspace* (Chat, Projects, Agents, Inbox, Memories & Dreams),
*Build* (Library, Skills, Plugins, Switchboard, Recurring Tasks), *Control* (Approvals, Usage & Quota, Logs);
*Settings* and *Help* pinned at the bottom; a ⌘K "Search everything" pill rendered disabled (search is out of scope).
Default landing route is Chat (milestones, owner call O2). Unauthenticated users are redirected to `#/login`; a
signed-in user on `#/login` is redirected to the landing route.

**Responsive (§13.7).** By viewport (content) width: compact < 1024: 64 px icon rail, labels as `aria-label`, menu
button opens a 288 px overlay over a scrim (Esc, close button or scrim click closes; focus moves in and returns);
normal 1024–1600: 256 px sidebar; wide > 1600: content capped (reading ≤ 72ch, forms ≤ 880), centred. Targets 44 px
compact, 24 px at normal and wide; text ≥ 12 px; works at 400 px; `prefers-reduced-motion` stops every animation.

**Theme.** Tokens as CSS custom properties on `:root` (dark is the base so "no preference" falls back to dark, C2);
`@media (prefers-color-scheme: light)` switches `:root:not([data-theme])`; `data-theme="light|dark"` is the explicit
override; the topbar control cycles system/light/dark. `color-scheme` is set accordingly. No inline script: the
override is applied when `main.js` runs (a brief first-paint flash for an override that differs from the OS setting is
accepted for the spike; the API can later set the attribute server-side).

**i18n.** `t(key, params?)` over typed catalogues `en`/`de` (a test asserts both have identical key sets and no empty
values); language signal `system | en | de`, `<html lang>` follows it, `Intl.DateTimeFormat`/`NumberFormat` helpers.

**Login against `/api/v1`.** `SessionApi` (the only thing UI code imports): `whoami()`, `login({username, password})`,
`logout()`. `HttpSessionApi(baseUrl, fetch)` implements it with `credentials: "same-origin"`, JSON bodies, the CSRF
token kept in memory only (never in storage), and typed failures (`invalid-credentials`, `rate-limited` with
`retryAfterSeconds`, `network`, `server`). Provisional routes, kept in one constants object so the real API is a small
diff (same convention as the desktop shell's §6.2 table):

| Route | Request → response |
|---|---|
| `GET /api/v1/auth/whoami` | cookie → `200 { userId, displayName, role }` or `401` |
| `POST /api/v1/auth/login` | `{ username, password }` → `200 { userId, displayName, role, csrf }` + `Set-Cookie`; `401` bad credentials; `429` + `Retry-After` |
| `POST /api/v1/auth/logout` | `X-CSRF-Token` → `204` |

Login form: labelled fields, `autocomplete` hints, `aria-invalid`/`aria-describedby` errors, a polite/assertive live
region for the result, submit disabled while pending, show/hide password toggle, no password in any log or storage.

**CSP.** Served by the mock exactly as ADR-004: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. (The
production header adds a per-response nonce; nothing here needs one because there is no inline script.) Tests fail on
any CSP violation event and any console error.

**Fonts.** The Glow type stack (Atkinson Hyperlegible Next, Lilita One, JetBrains Mono) must be bundled locally (ADR-004:
no remote origins) but no font files are in the repo and none may be downloaded here. **RULING:** this spike declares the
stack with system fallbacks (`ui-sans-serif`, `system-ui`, …) and a documented TODO to add the licensed font files with
the asset task; no layout depends on font metrics.

## 3. Tasks (test first, small commits)

1. Plan + spike doc (this file, `docs/ui/framework-spike.md` stub with the numbers).
2. Package scaffold: `package.json`, `build.mjs`, `index.html`, empty app, `build.test.ts` (no inline script/style,
   no `eval`/`new Function`, bundle budget) — red then green.
3. `prefs.ts`, `i18n.ts` + catalogue test; `theme.ts` + tokens.
4. `router.ts`, `nav.ts`, `session.ts` (interface + HTTP client) with `mock-server.ts` and `session-api.test.ts`.
5. Shell components + CSS (sidebar/rail/overlay/topbar), placeholder pages; `e2e.test.ts` for navigation, theme, language.
6. Login page + auth gate; E2E login/logout/error/rate-limit.
7. `a11y.test.ts` (axe: login + shell, light and dark, three widths) and `responsive.test.ts` (structural snapshots).
8. Docs (`docs/ui/web-shell.md`, bundle size report), AGENTS.md package row (one line), lint-hygiene check, final full gate.

## 4. Acceptance → test

| Acceptance | Test |
|---|---|
| Framework spike with 2 options, decision by RULING (bundle, a11y, CSP) | §1 above; `docs/ui/framework-spike.md` |
| Shell: sidebar groups per canvas, routing | `e2e.test.ts` "sidebar groups and items", "routes render and the active item is marked" |
| Light/dark theme with tokens, three-state override, dark fallback | `e2e.test.ts` "theme follows the OS", "dark when the OS has no preference", "override wins and survives reload" |
| Responsive phone/tablet/desktop, rules of §13.7 | `responsive.test.ts` (400 / 960 / 1440 / 2560 modes, no horizontal scroll, target sizes, text ≥ 12 px, overlay Esc/scrim) |
| i18n frame de/en | `build.test.ts`/`i18n` catalogue parity; `e2e.test.ts` "language switch updates text and lang" |
| Login against `/api/v1` behind an interface with a mock | `session-api.test.ts` (client vs mock), `e2e.test.ts` login, bad password, rate limit, logout, redirect gates |
| Static build, strict CSP without inline script | `build.test.ts` (static HTML/JS audit), `e2e.test.ts` "no CSP violations or console errors" under the strict header |
| Playwright component/E2E against the mock | `e2e.test.ts` (Chromium from `/opt/pw-browsers`, no download) |
| a11y: axe without violations on shell + login | `a11y.test.ts` |
| Responsive snapshots at 3 widths | `responsive.test.ts` against `test/fixtures/responsive.json` (structural); pixel screenshots written to a temp dir, not committed |
| Bundle size documented | `docs/ui/framework-spike.md`; `build.test.ts` asserts the budget and prints the numbers |

## 5. Rulings (recorded in the PR)

1. Framework: Preact + Signals (§1).
2. `h()` in `.ts`, no JSX, so the root typecheck covers the package without touching `tsconfig.base.json`.
3. Hash routing, so a static host needs no history-API fallback.
4. Provisional `/api/v1/auth/{whoami,login,logout}` routes behind `SessionApi`; confirm against task 1's API.
5. Fonts: system fallbacks until licensed font files are added.
6. Responsive "snapshots" are structural JSON (deterministic across OS); pixel PNGs are not committed.
7. Engine pin: `pnpm install` on this branch touched only the lockfile's new web entries; the engine line is unchanged.
8. Search pill present but disabled (⌘K search is separate scope).
