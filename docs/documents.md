# Documents (D100)

Agency-grade documents: one design system, rendered by a real layout engine, and checked before delivery
(spec `docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md` §D100).

## What exists

- **`skills/document-design/`** — the design system as a skill: typography, contrast-checked colour tokens, page layout,
  the nine templates, and the rendering safety rules.
- **`packages/documents/`** (`@plur1bus/documents`) — tokens, templates, the Markdown→HTML→PDF renderer, the automatic
  checks, the brand kit and the chart/diagram generators.
- **`document.render`** — the tool an agent calls: `{ template, content (Markdown), title, outputPath, meta? }` → a PDF
  inside the granted roots, plus a review report.

## Templates

`report`, `essay`, `white-paper`, `proposal`, `one-pager`, `letter`, `invoice`, `cv`, `slides` — each HTML/CSS over the
shared base stylesheet. The base stylesheet carries the colour tokens, the type scale (Inter / Source Serif 4 / JetBrains
Mono), a 60–75ch measure, an A4 page box and running heads/footers with page counters.

## Rendering

HTML/CSS (with Paged.js for print layout) → Chromium's `Page.printToPDF` via a dependency-free CDP driver
(`packages/documents/src/chromium.ts`). Fonts are embedded as `data:` URLs, so the PDF is self-contained and deterministic.
**Typst** is a second engine for math-heavy or very long documents, used when the `typst` binary is installed; without it the
renderer reports a clear message and falls back to the HTML engine.

### Rendering is an outside surface

- Agent content is untrusted: Markdown is HTML-escaped and re-sanitised — no script from content, no `javascript:`/`file:`/
  network resource reference.
- No network at render time: fonts and CSS are inlined; requests are blocked.
- File paths stay inside the granted roots (`requireRoot: true`, re-checked at execution).
- Size and time limits: content ≤ 200 000 chars, title ≤ 300, a render time budget.

## Visual review (mandatory)

Before delivery every document is checked (D100 §3):

- **Static checks** — broken links, images below 150 dpi at print size, missing fonts, inline contrast below 4.5:1.
- **Layout checks** (in the renderer) — text overflow/clipped boxes, single-word last lines (widows), forced empty pages.
- **Vision review** — only when a vision-capable model is configured; at most three fix rounds; without it the automatic
  checks only and the delivery says so.

The delivery carries a short report: what was checked, what was found, what was fixed, and whether the vision review ran.

## Brand kit

Logo, colours, fonts and tone stored once per installation/project, overlaid on the neutral PLUR1BUS kit. Colours are
re-checked against WCAG AA on load; a pair that misses the floor yields a warning and a concrete suggestion. Logos are
raster images (PNG/JPEG/WebP, magic-byte check, 2 MiB limit); SVG is sanitised or rejected.

## Charts and diagrams

Vega-Lite (BSD-3) and Mermaid (MIT) with the kit's palette and type baked in — never the library defaults. The spec/definition
generators live in `packages/documents/src/charts.ts`; rendering them into a document is a follow-up.

## Golden set

One document per template is rendered in CI and compared against approved reference images by a visual diff (threshold
documented in the CI job). The fonts are embedded, so the diff is deterministic across runners.

## Limits and known gaps

- **DOCX/PPTX/XLSX export** is not built (new dependencies; owner question).
- **Sandbox**: rendering does not yet run inside `sandboxSpawn` (D106, not merged); it spawns Chromium directly with a
  throwaway profile and no network references.
- **Typst** is an external binary, never bundled.
- **Vision model** wiring is a follow-up; the `VisionReviewer` port is defined and tested by substitution.
