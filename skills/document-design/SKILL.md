---
name: document-design
description: The PLUR1BUS document design system (D100) — typography, colour tokens with WCAG AA contrast, page layout, and the nine templates (report, essay, white paper, proposal, one-pager, letter, invoice, CV, slide deck). Use whenever you produce a designed PDF document for a person via the `document.render` tool, or when you need the shared type scale, colour palette and layout rules.
category: docs.create
useWhen: Create a designed PDF document with document.render or choose its typography, colour palette, layout and template.
---

# document-design

One design system for every document an agent produces for a person (D100 §1). The source of truth for the
tokens and templates is `packages/documents` (`src/tokens.ts`, `src/templates.ts`); rendering goes through a real
layout engine (Chromium `Page.printToPDF`, with Paged.js for running heads, page counters and footnotes), and every
delivery is checked visually before it goes out (the automatic checks and vision review, D100 §3).

## 1. Typography

- **Families (SIL OFL, licensed for redistribution):** Inter (modern sans), Source Serif 4 (text serif), JetBrains
  Mono (mono). Fallbacks are system faces; the renderer embeds the real faces as `data:` URLs, so the PDF is
  self-contained and deterministic.
- **Type scale** (1.15–1.5 ratio steps), relative to an 11 pt base:

  | Role | Size | Family |
  |---|---|---|
  | Cover title | 3.2 rem | Inter |
  | H1 | 2.2 rem | Inter |
  | H2 | 1.5 rem | Inter |
  | H3 | 1.2 rem | Inter |
  | H4 / caption label | 1 rem, uppercase | Inter |
  | Body | 1 rem (11 pt) | Source Serif 4 (serif templates) / Inter (sans templates) |
  | Caption, footer | 0.8 rem | Inter |
  | Code | 0.9 rem | JetBrains Mono |

- **Line length:** 60–75 characters per line (the `--measure` token is 66ch). Never let a body paragraph exceed it.
- **Baseline rhythm:** line-height 1.5 everywhere; headings clear whole multiples of the baseline where the font's
  metrics allow. Avoid arbitrary fractional margins that break the grid.
- **Real small caps and figures:** where a face ships them (Inter's tabular figures, Source Serif 4's small caps and
  old-style figures), use `font-variant-numeric: tabular-nums` for tables and `font-variant-caps: small-caps` for
  running heads; never fake small caps by shrinking uppercase.

## 2. Colour tokens (computed WCAG AA)

The palette is a set of named tokens, not ad-hoc hex values. `packages/documents/src/tokens.ts` **computes** the WCAG
2.x contrast ratio of every declared pair and the test fails below threshold; a brand kit (D100 §4) replaces the values
and re-runs the same check. Thresholds: **4.5:1** for body text, **3:1** for large text (headings, pull quotes).

The neutral PLUR1BUS kit:

| Token | Value | Use |
|---|---|---|
| `paper` | `#ffffff` | body background |
| `text` | `#1a1c20` | primary text (17:1 on paper) |
| `muted` | `#4b5563` | secondary text, captions, footnotes (≥ 4.5:1) |
| `accent` | `#2563eb` | headings, links, rules (≥ 3:1, 5.2:1 on paper) |
| `on-accent` | `#ffffff` | text on an accent ground |
| `cover-light-*` | accent ground / white text | light cover |
| `cover-dark-*` | `#111827` ground / `#f5f7fa` text | dark cover |

One accent colour per document. Never invent a colour that was not contrast-checked; if a brand kit colour misses the
AA floor, warn and propose a darker/lighter variant instead of rendering silently.

## 3. Layout

- **Page:** A4 (210 × 297 mm); slides use 254 × 190.5 mm landscape.
- **Margins:** 18 mm top / 16 mm sides / 20 mm bottom — generous, agency-grade whitespace, never tight.
- **Grid:** an invisible column grid; text sits on the measure, figures and tables may span it but stay aligned.
- **Cover page:** light or dark variant (accent ground or near-black ground), kicker, title, subtitle, byline.
- **Table of contents:** generated from headings; Paged.js fills the page numbers.
- **Running heads/footers:** short title top-left, author top-right, page number bottom-centre, on every page except
  the cover.
- **Structures:** pull quotes and callouts (accent left rule), figure/table captions (`caption` class, 0.8 rem muted),
  footnotes/endnotes (Paged.js), and a bibliography block in the template's citation style.

## 4. Templates

Nine templates in `packages/documents/src/templates.ts`, each HTML/CSS over the base stylesheet:

| Id | Name | Body face | Notes |
|---|---|---|---|
| `report` | Report | serif | dark cover, TOC, sections |
| `essay` | Essay | serif | centred title, justified, hyphenated |
| `white-paper` | White paper | serif | light cover, ruled H2s |
| `proposal` | Proposal | sans | light cover, summary/scope/pricing |
| `one-pager` | One-pager | sans | single page, no cover |
| `letter` | Letter | serif | sender/recipient, salutation, signature |
| `invoice` | Invoice / offer | sans | line items, total, notes |
| `cv` | CV | sans | role/experience sections |
| `slides` | Slide deck | sans | one slide per H2, landscape |

## 5. Rendering rules (an outside surface — content is untrusted)

- **No network at render time.** The HTML the renderer hands to Chromium is self-contained: inline CSS, fonts as
  `data:` URLs. It must contain no `http(s)://`, `//`, `file:` or `javascript:` resource reference. Requests are
  blocked.
- **No script from content.** Agent Markdown is HTML-escaped and re-sanitised; the only script in the document is our
  own (Paged.js). No `<script>`, `<iframe>`, `on*=` handler or `style=` from content survives.
- **Paths stay inside the roots.** `document.render` writes its PDF only inside the granted roots (`requireRoot: true`),
  and re-checks the path at execution time (fail closed).
- **Limits.** Content ≤ 200 000 chars, title ≤ 300, a render time budget; the tool is a normal capability-gated tool
  (`fs.write`), so it goes through policy and the dispatcher like every other tool.

## 5a. Visual review before delivery (mandatory)

Every document is checked before it goes out (D100 §3):

- **Static checks** (no browser): broken links (`javascript:`/`file:`/missing `#fragment`), images below 150 dpi at print
  size, a font family that is used but neither embedded nor a system fallback, and inline colour pairs below 4.5:1.
- **Layout checks** (in the renderer): text overflow / clipped boxes, single-word last lines (widows), and forced empty
  pages.
- **Vision review** (only when a vision-capable model is configured): the page is checked against the checklist —
  hierarchy, alignment, whitespace, consistency — with at most three fix rounds.

The delivery carries a short report: what was checked, what was found, what was fixed, and whether the vision review ran.
Without a vision model only the automatic checks run, and the report says so explicitly. A document with an `error` finding
is not agency-grade; fix the seed (content or template) and re-render rather than shipping it.

## 6. Using it

Prefer the `document.render` tool: give it a `template`, Markdown `content`, a `title`, and an `outputPath` inside the
roots; template-specific fields (author, date, invoice lines, letter salutation, …) go in `meta`. The tool renders the
PDF, embeds the fonts, and reports the output path and byte count. Read the delivery's review report (D100 §3) before
sending the file — a document that failed a visual check is not delivered.
