// The nine document templates of D100 §1. Each template is authored HTML/CSS over the shared design system: the base
// stylesheet carries the colour tokens (injected as CSS variables from a kit), the type scale, the grid, the page box and
// the running heads/footers with page counters (Paged.js); a template adds its cover, its fonts and its section rules.
// Content (the agent's Markdown) is rendered separately and interpolated as trusted, sanitised fragments — never as raw
// markup — into the assembled body.

import { NEUTRAL_KIT, kitToCssVariables, type NeutralKit } from "./tokens.ts";
import { escapeHtml } from "./markdown.ts";

export const TEMPLATE_IDS = [
  "report",
  "essay",
  "white-paper",
  "proposal",
  "one-pager",
  "letter",
  "invoice",
  "cv",
  "slides",
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface DocumentMeta {
  readonly title?: string;
  readonly subtitle?: string;
  readonly author?: string;
  readonly date?: string;
  /** Free-form template metadata (invoice lines, letter salutation, …). Trusted data only; rendered escaped. */
  readonly [key: string]: unknown;
}

export interface Template {
  readonly id: TemplateId;
  readonly name: string;
  /** One-line description for the tool schema and the skill. */
  readonly description: string;
  /** Font family the running text uses. */
  readonly bodyFont: "sans" | "serif";
  /** The expected page count a sample document renders to (asserted when a real browser is available). */
  readonly samplePageCount: number;
  /** Template CSS (concatenated after the base). */
  readonly css: string;
  /** Assemble the cover + document body for this template. `bodyHtml` is already-sanitised HTML. */
  readonly build: (input: { title: string; subtitle: string; bodyHtml: string; meta: DocumentMeta }) => string;
}

/** Escape an arbitrary metadata value for interpolation into authored HTML. */
function esc(v: unknown): string {
  return escapeHtml(String(v ?? ""));
}

/** The base (design-system) stylesheet, with `__KIT__` replaced by the kit's CSS variables at build time. */
export const BASE_CSS = `\
:root {
__KIT__
  --font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-serif: "Source Serif 4", Georgia, "Times New Roman", serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --base-size: 11pt;
  --line: 1.5;
  --gutter: 18mm;
  --measure: 66ch; /* 60–75 characters per line (D100 §1) */
}

@page {
  size: A4;
  margin: 18mm 16mm 20mm;
  @bottom-center { content: counter(page); font-family: var(--font-sans); font-size: 9pt; color: var(--doc-muted); }
  @top-left { content: string(doctitle); font-family: var(--font-sans); font-size: 8pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--doc-muted); }
  @top-right { content: string(docauthor); font-family: var(--font-sans); font-size: 8pt; color: var(--doc-muted); }
}

html { font-size: var(--base-size); }
body {
  font-family: var(--font-serif);
  color: var(--doc-text);
  background: var(--doc-paper);
  line-height: var(--line);
  font-size: 1rem;
  margin: 0;
}
body.sans { font-family: var(--font-sans); }

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-sans);
  color: var(--doc-text);
  line-height: 1.15;
  margin: 1.6em 0 0.5em;
}
h1 { font-size: 2.2rem; letter-spacing: -0.01em; string-set: doctitle content(); }
h2 { font-size: 1.5rem; }
h3 { font-size: 1.2rem; }
h4 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--doc-muted); }

p { margin: 0 0 0.8em; max-width: var(--measure); }
a { color: var(--doc-accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--doc-accent) 40%, transparent); }
strong { font-weight: 600; }
code { font-family: var(--font-mono); font-size: 0.9em; background: color-mix(in srgb, var(--doc-text) 6%, transparent); border-radius: 3px; padding: 0 0.25em; }
pre { font-family: var(--font-mono); font-size: 0.85em; line-height: 1.4; background: color-mix(in srgb, var(--doc-text) 6%, transparent); border-radius: 4px; padding: 0.8em 1em; }
blockquote {
  margin: 1.2em 0; padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid var(--doc-accent);
  font-style: italic; color: var(--doc-muted);
}
hr { border: none; border-top: 1px solid color-mix(in srgb, var(--doc-text) 15%, transparent); margin: 2em 0; }
ul, ol { padding-left: 1.4em; max-width: var(--measure); }
li { margin-bottom: 0.35em; }

.cover {
  page: cover; break-after: page;
  min-height: 90vh; box-sizing: border-box;
  display: flex; flex-direction: column; justify-content: flex-end;
  padding: 30mm 16mm;
}
@page cover { margin: 0; }
.cover .kicker { font-family: var(--font-sans); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.14em; margin-bottom: 1em; }
.cover h1 { font-size: 3.2rem; margin: 0 0 0.3em; max-width: 22ch; color: inherit; }
.cover .subtitle { font-size: 1.15rem; max-width: var(--measure); }
.cover .byline { font-family: var(--font-sans); font-size: 0.85rem; margin-top: 2em; }

.caption { font-family: var(--font-sans); font-size: 0.8rem; color: var(--doc-muted); margin-top: 0.4em; }
.callout {
  margin: 1.4em 0; padding: 0.9em 1.1em;
  background: color-mix(in srgb, var(--doc-accent) 8%, transparent);
  border-left: 3px solid var(--doc-accent);
  border-radius: 0 4px 4px 0;
}
.callout p:last-child { margin-bottom: 0; }
`;

/** A light cover (accent ground, white text). */
function lightCover(t: { title: string; subtitle: string; author: string; kicker: string }): string {
  return `<div class="cover" style="background:var(--doc-cover-light-ground);color:var(--doc-cover-light-text);--cover-sub:rgba(255,255,255,0.82)">
  <div class="kicker">${esc(t.kicker)}</div>
  <h1>${esc(t.title)}</h1>
  <div class="subtitle" style="color:var(--cover-sub)">${esc(t.subtitle)}</div>
  <div class="byline" style="color:var(--cover-sub)">${esc(t.author)}</div>
</div>`;
}

/** A dark cover (near-black ground, light text). */
function darkCover(t: { title: string; subtitle: string; author: string; kicker: string }): string {
  return `<div class="cover" style="background:var(--doc-cover-dark-ground);color:var(--doc-cover-dark-text);--cover-sub:rgba(245,247,250,0.72)">
  <div class="kicker">${esc(t.kicker)}</div>
  <h1>${esc(t.title)}</h1>
  <div class="subtitle" style="color:var(--cover-sub)">${esc(t.subtitle)}</div>
  <div class="byline" style="color:var(--cover-sub)">${esc(t.author)}</div>
</div>`;
}

function titleBlock(title: string, subtitle: string): string {
  const sub = subtitle ? `<div class="subtitle" style="font-size:1.1rem;color:var(--doc-muted)">${esc(subtitle)}</div>` : "";
  return `<header>${sub}<h1>${esc(title)}</h1></header>`;
}

const invoiceLines = (meta: DocumentMeta): string =>
  (meta.lineItems as readonly { label?: unknown; amount?: unknown }[] | undefined)
    ?.map((it) => `<tr><td>${esc(it.label)}</td><td class="num">${esc(it.amount)}</td></tr>`)
    .join("\n") ?? "";

export const TEMPLATES: ReadonlyMap<TemplateId, Template> = new Map<TemplateId, Template>([
  ["report", {
    id: "report", name: "Report", description: "A structured report with cover, table of contents and sections.",
    bodyFont: "serif", samplePageCount: 3,
    css: "",
    build: ({ title, subtitle, bodyHtml, meta }) => `${darkCover({ title, subtitle, author: esc(meta.author), kicker: "Report" })}
${titleBlock(title, subtitle)}${bodyHtml}`,
  }],
  ["essay", {
    id: "essay", name: "Essay", description: "A long-form serif essay with a centred title and generous measure.",
    bodyFont: "serif", samplePageCount: 3,
    css: "body { font-size: 1.05rem; } h1 { text-align: center; } p { text-align: justify; hyphens: auto; }",
    build: ({ title, subtitle, bodyHtml }) => `<header style="margin-top:12mm;text-align:center"><div class="kicker" style="font-family:var(--font-sans);text-transform:uppercase;letter-spacing:.14em;font-size:.8rem;color:var(--doc-muted)">Essay</div><h1>${esc(title)}</h1><div class="subtitle" style="color:var(--doc-muted)">${esc(subtitle)}</div></header>${bodyHtml}`,
  }],
  ["white-paper", {
    id: "white-paper", name: "White paper", description: "A technical white paper with an executive summary and numbered findings.",
    bodyFont: "serif", samplePageCount: 4,
    css: "h2 { border-bottom: 1px solid color-mix(in srgb, var(--doc-text) 15%, transparent); padding-bottom: 0.25em; }",
    build: ({ title, subtitle, bodyHtml, meta }) => `${lightCover({ title, subtitle, author: esc(meta.author), kicker: "White paper" })}
${titleBlock(title, subtitle)}${bodyHtml}`,
  }],
  ["proposal", {
    id: "proposal", name: "Proposal", description: "A business proposal with a summary, scope and pricing sections.",
    bodyFont: "sans", samplePageCount: 3,
    css: "body { font-family: var(--font-sans); }",
    build: ({ title, subtitle, bodyHtml, meta }) => `${lightCover({ title, subtitle, author: esc(meta.author), kicker: "Proposal" })}
${titleBlock(title, subtitle)}${bodyHtml}`,
  }],
  ["one-pager", {
    id: "one-pager", name: "One-pager", description: "A single-page summary: no cover, everything on one page.",
    bodyFont: "sans", samplePageCount: 1,
    css: "body { font-family: var(--font-sans); } h1 { font-size: 1.8rem; }",
    build: ({ title, subtitle, bodyHtml }) => `${titleBlock(title, subtitle)}${bodyHtml}`,
  }],
  ["letter", {
    id: "letter", name: "Letter", description: "A business letter with sender, recipient, salutation and signature block.",
    bodyFont: "serif", samplePageCount: 1,
    css: "body { font-size: 1.02rem; } .letter-meta { font-family: var(--font-sans); font-size: 0.85rem; color: var(--doc-muted); margin-bottom: 1.4em; }",
    build: ({ bodyHtml, meta }) => `<div class="letter-meta">${esc(meta.from)}<br>${esc(meta.date)}<br><br>${esc(meta.to)}</div>
<div style="font-family:var(--font-sans);font-size:.9rem;color:var(--doc-muted);text-transform:uppercase;letter-spacing:.08em">${esc(meta.subject)}</div>
<h1 style="font-size:1.4rem">${esc(meta.salutation)}</h1>
${bodyHtml}
<p>${esc(meta.closing)}</p>
<p style="font-family:var(--font-sans)">${esc(meta.author)}</p>`,
  }],
  ["invoice", {
    id: "invoice", name: "Invoice / offer", description: "An invoice or offer with line items and a total.",
    bodyFont: "sans", samplePageCount: 1,
    css: "body { font-family: var(--font-sans); } table { width: 100%; border-collapse: collapse; margin: 1.4em 0; } th, td { text-align: left; padding: 0.5em 0.6em; border-bottom: 1px solid color-mix(in srgb, var(--doc-text) 12%, transparent); } .num { text-align: right; font-variant-numeric: tabular-nums; }",
    build: ({ meta, bodyHtml }) => `<h1>${esc(meta.title ?? "Invoice")}</h1>
<div style="font-family:var(--font-sans);font-size:.85rem;color:var(--doc-muted)">${esc(meta.from)} &rarr; ${esc(meta.to)}<br>${esc(meta.date)}</div>
<table><thead><tr><th>Item</th><th class="num">Amount</th></tr></thead><tbody>${invoiceLines(meta)}</tbody></table>
<p style="font-family:var(--font-sans);font-weight:600;text-align:right">Total: ${esc(meta.total)}</p>
${bodyHtml}`,
  }],
  ["cv", {
    id: "cv", name: "CV", description: "A curriculum vitae with role/experience sections.",
    bodyFont: "sans", samplePageCount: 2,
    css: "body { font-family: var(--font-sans); } h3 { margin-bottom: 0.2em; } .role-meta { font-size: 0.8rem; color: var(--doc-muted); text-transform: uppercase; letter-spacing: .06em; }",
    build: ({ meta, bodyHtml }) => `<h1>${esc(meta.title)}</h1>
<div style="font-family:var(--font-sans);color:var(--doc-muted)">${esc(meta.role)} &middot; ${esc(meta.author)}</div>
${bodyHtml}`,
  }],
  ["slides", {
    id: "slides", name: "Slide deck", description: "A landscape slide deck: each top-level heading is one slide.",
    bodyFont: "sans", samplePageCount: 2,
    css: "body { font-family: var(--font-sans); } section.slide { break-after: page; min-height: 80vh; display: flex; flex-direction: column; justify-content: center; } @page { size: 254mm 190.5mm; } .slide h2 { font-size: 1.8rem; }",
    build: ({ bodyHtml }) => `${slidesFromBody(bodyHtml)}`,
  }],
]);

/** Turn top-level `h2` sections into one slide each (the Markdown renderer emits `<h2>` without attributes). */
function slidesFromBody(bodyHtml: string): string {
  const parts = bodyHtml.split(/(?=<h2>)/);
  if (parts.length === 1) return `<section class="slide"><h2>Slides</h2>${bodyHtml}</section>`;
  return parts.map((p) => `<section class="slide">${p}</section>`).join("\n");
}

/** Assemble a complete, self-contained HTML document for a template + content. */
export function buildDocumentHtml(templateId: TemplateId, input: { title: string; subtitle: string; bodyHtml: string; meta: DocumentMeta; kit?: NeutralKit }): string {
  const template = TEMPLATES.get(templateId);
  if (!template) throw new Error(`unknown template ${templateId}`);
  const kit = input.kit ?? NEUTRAL_KIT;
  const body = template.build({ ...input, meta: input.meta });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<style>
${BASE_CSS.replace("__KIT__", kitToCssVariables(kit))}
${template.css}
</style>
</head>
<body class="${template.bodyFont}">
${body}
</body>
</html>`;
}
