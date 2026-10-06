# Web UI shell (`packages/web`)

`@plur1bus/web` is the foundation of the M3 web UI: app shell, theme, i18n frame and sign-in. It is a static build
(`index.html`, `main.js`, `styles.css`, no inline script or style) that the Harness API will serve at `/`. It talks to
the API only through `SessionApi` (`src/session.ts`). Pages other than sign-in are placeholders until their M3 steps.

Authorities: ADR-004, desktop spec §13.1 (Glow tokens, `V2Sidebar`) and §13.7 (responsive rules), `docs/milestones.md`
M3. Framework decision and measurements: [`framework-spike.md`](framework-spike.md).

## Run and test

```bash
export PATH=/home/claude/.node24/bin:$PATH
pnpm --filter @plur1bus/web build          # packages/web/dist
pnpm --filter @plur1bus/web test           # node:test; browser suites need a Chromium
```

The browser suites (`e2e`, `a11y`, `responsive`) launch Chromium through Playwright, taken from `PLUR1BUS_CHROMIUM`,
Playwright's own install, or `/opt/pw-browsers/chromium`; nothing is downloaded. Without a browser they are skipped, so
a plain `pnpm test` stays green; `PLUR1BUS_WEB_E2E_REQUIRED=1` turns a missing browser into a failure (use it in a job
that installs one). `UPDATE_SNAPSHOTS=1` rewrites `test/fixtures/responsive.json`; `PLUR1BUS_WEB_SHOTS_DIR=<dir>` also
writes pixel screenshots there (not committed: they vary with fonts and OS).

All tests run against `test/mock-server.ts`: the built files under the strict CSP of ADR-004 plus a mock of the
provisional session routes, on `127.0.0.1` with an ephemeral port. No test reaches a real harness or the network.

## Layout and routes

Sidebar groups as drawn on the canvas: **Workspace** (Chat, Projects, Agents, Inbox, Memories & Dreams), **Build**
(Library, Skills, Plugins, Switchboard, Recurring Tasks), **Control** (Approvals, Usage & Quota, Logs); **Settings** and
**Help** are pinned at the bottom. Routes are hash routes (`#/chat`, …, `#/login`) so a static host needs no history
fallback. The landing route is Chat (owner call O2). A signed-out visit goes to `#/login` and returns to the requested
page after sign-in; a signed-in visit to `#/login` goes to Chat. Navigation moves focus to the page heading.

| Width (CSS px) | Mode | Sidebar | Targets | Header actions |
|---|---|---|---|---|
| < 1024 (compact, works to 400) | rail | 64 px icons; the menu button opens a 288 px overlay over a scrim (Esc, scrim, link or growing the window closes it; focus is trapped inside and returns) | 44 px | theme, language, user in a "More" disclosure |
| 1024–1600 (normal) | full | 256 px | 36 px (≥ 24 px required) | inline |
| > 1600 (wide) | full | 256 px | 36 px | inline; page content stays ≤ 880 px and is centred |

Text is never below 12 px; no width scrolls horizontally; `prefers-reduced-motion` removes animation and transitions.

## Theme and language

Tokens live in `src/styles/tokens.css` (Glow, desktop spec §13.1) and are the only token source. Dark is the base, so an
OS with no preference gets dark; `prefers-color-scheme: light` switches to light; the header or sign-in picker
sets `data-theme` (system / light / dark) which wins and is remembered. Preferences are kept in `localStorage` through
guarded access with an in-memory fallback. `en` and `de` catalogues are in `src/i18n.ts` (a test asserts identical keys
and placeholders); the language follows the browser unless picked, and `<html lang>` follows it.

## Session API (provisional)

`SessionApi` is the only thing UI code uses; `HttpSessionApi` implements it. Routes are constants in `SESSION_ROUTES`
so the real API is a small diff. They are provisional because the Harness API is built in a parallel task.

| Route | Request → response |
|---|---|
| `GET /api/v1/auth/whoami` | session cookie → `200 { userId, displayName, role }` (optionally `csrf`), `401` without a session |
| `POST /api/v1/auth/login` | `{ username, password }` → `200 { userId, displayName, role, csrf }` + `Set-Cookie`; `401` bad credentials; `429` + `Retry-After` |
| `POST /api/v1/auth/logout` | `X-CSRF-Token` → `204` |

The CSRF token is held in memory only, the password is never put in a URL, a log or storage, and the session cookie is
the server's `HttpOnly` cookie, never readable from script.

## Rulings

1. **Framework:** Preact + Signals (spike).
2. **`h()` in `.ts`, no JSX**, so root typecheck covers the package unchanged.
3. **Hash routing.**
4. **Provisional `/api/v1/auth/*` routes** behind `SessionApi`; reconcile with the real API.
5. **Fonts:** system fallbacks until the licensed Glow font files are added.
6. **Responsive snapshots** are structural, not pixels.
7. **Field borders** use `--field-border` (≥ 3:1 against the surface, WCAG 1.4.11) instead of the canvas's lighter card
   border, which is kept for cards and dividers only.
8. **Search pill** is drawn and disabled; ⌘K search is separate scope.

## Open points

- Add a Chromium install step to the main CI job (or run this package's tests in a job that has one) so the browser
  suites run there; `.github/workflows/**` was out of bounds for this change. Until then CI skips them.
- Bundle Atkinson Hyperlegible Next, Lilita One and JetBrains Mono (ADR-004: fonts local, no remote origin).
- The production CSP adds a per-response nonce; nothing here uses one, so the static build already satisfies it.
- Wordmark morph (`V2LogoMorph`), Projects list in the sidebar, badges, the "More" menu for primary header actions
  of real pages, and dark variants of every board are page-level work.
