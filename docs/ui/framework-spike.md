# Web UI framework spike (ADR-004 Q1)

Scope: the scaled-down spike of the M3 UI-shell task (2026-10-06), **not** the full two-day Models-page build that
ADR-004's action item 1 describes. It settles the framework with measurements; the Models page, first-paint timing and a
full keyboard-traversal comparison remain open for the page work.

## Method

The same minimal slice was built twice: a navigation list plus a sign-in form (two controlled inputs, a derived label,
a submit button). Each was bundled with the repo's own esbuild (`--bundle --minify --format=esm --target=es2022`) and
measured raw and with `gzip -9`. The throwaway entries are not committed; Lit is not a dependency of the package.

| | Preact 10.29 + `@preact/signals` 2.11 | Lit 3.3 |
|---|---|---|
| Slice JS, minified | 20.9 kB | 15.2 kB |
| Slice JS, gzip | **8.2 kB** | **5.9 kB** |
| Strict CSP (`script-src 'self'; style-src 'self'`) | clean | clean (light DOM; shadow DOM needs `adoptedStyleSheets`) |
| `label for` / ARIA id references across the page | work (light DOM) | break across shadow roots unless the render root is the light DOM |
| Shared reactive state (session, theme, language, route) | signals, no store code | per element |

## Decision (RULING)

**Preact + Signals, TypeScript, esbuild, written with `h()` in `.ts` files.** The 2.3 kB gzip difference is small against
the 25 kB budget the build test enforces; Lit's only way to keep ARIA references valid is to turn off its encapsulation;
shared reactive state is the shell's main cross-cutting need; and this matches the ADR recommendation, now with a
measurement behind it. Lit stays the named fallback (ADR-004 "Revisit when").

`h()` instead of JSX keeps the package inside the root `tsc -p tsconfig.base.json` (`erasableSyntaxOnly`, no JSX flag)
with no change to that shared file.

## Bundle size of the shipped shell

Measured by `packages/web/test/build.test.ts` (it prints the line and fails over budget), 2026-10-06, shell + login +
de/en catalogues + Glow tokens:

| File | Minified | gzip -9 | Budget (gzip) |
|---|---|---|---|
| `main.js` | 37.6 kB | **14.4 kB** | 25 kB |
| `styles.css` | 8.0 kB | **2.6 kB** | 6 kB |
| `index.html` | 0.4 kB | | |
| **Total** | | **≈ 17 kB** | |

Preact + signals account for roughly 8 kB of the JavaScript; the rest is the app, both catalogues and the icon paths.
No fonts are shipped yet (see `docs/ui/web-shell.md`, "Open points").
