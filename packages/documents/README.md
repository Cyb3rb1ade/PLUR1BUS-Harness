# @plur1bus/documents

The D100 document design system and HTML→PDF renderer: colour tokens with computed WCAG AA contrast, the nine
templates, a self-contained Markdown→HTML→PDF pipeline over Chromium's `Page.printToPDF`, and the `document.render`
tool contract (spec `docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md` §D100).

## Purpose

Documents an agent produces for people follow **one** design system, rendered by a real layout engine and checked
before delivery. This package owns the design tokens, templates and rendering; the core composition registers the
`document.render` tool and confines its output to the granted roots.

## Surface

- **Design tokens** — `src/tokens.ts`: the neutral PLUR1BUS kit and the WCAG 2.x contrast computation
  (`contrast`, `relativeLuminance`) with the declared AA thresholds (4.5:1 body, 3:1 large).
- **Templates** — `src/templates.ts`: `report`, `essay`, `white-paper`, `proposal`, `one-pager`, `letter`,
  `invoice`, `cv`, `slides`, each HTML/CSS over the shared base stylesheet.
- **Rendering** — `src/render.ts` (`assembleHtml`, `renderDocument`) and `src/chromium.ts` (a dependency-free
  Chromium CDP driver with a minimal RFC 6455 client). The `BrowserPort` seam lets tests substitute a fake.
- **Tool contract** — `src/schema.ts`: the `document.render` input schema and description. The `ToolDef` itself is
  registered by `packages/core/src/composition/tools.ts` with `capability: fs.write` and `requireRoot: true` output.

## Dependencies (exactly pinned, with licence)

- `pagedjs@0.4.3` (MIT) — print layout: running heads, page counters, footnotes.
- Fonts are SIL OFL assets (`assets/fonts/`): Inter, Source Serif 4, JetBrains Mono, each with its licence file.

## Security model (rendering is an outside surface)

Agent content is untrusted. The renderer assembles a self-contained document — inline CSS, fonts as `data:` URLs —
with **no network references**, escapes and re-sanitises the Markdown so **no script from content runs**, and the
tool writes only **inside the granted roots** (`requireRoot: true`, re-checked at execution). See `SKILL.md` §5.

## Run and test in isolation

```bash
cd packages/documents
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/*.test.ts
```

The unit tests substitute a fake browser and assert the assembled HTML carries no script and no external resource; a
real-Chromium end-to-end render is gated behind `PLUR1BUS_DOCUMENTS_E2E_REQUIRED=1` plus a Chromium binary
(`PLUR1BUS_CHROMIUM_BIN`, or a system Chrome/Chromium).
