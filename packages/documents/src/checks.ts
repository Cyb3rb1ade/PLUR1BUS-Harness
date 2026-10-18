// Automatic document checks (D100 §3). A document must pass these before delivery. The static checks run on the assembled
// HTML (no browser): broken links, images below 150 dpi at print size, missing fonts, and inline low-contrast colour pairs.
// The layout checks need a real layout engine and run inside Chromium via `layoutCheckScript()`: text overflow, widows and
// empty pages. A review report lists what was checked, what was found and what was fixed.

import { BODY_CONTRAST, contrast } from "./tokens.ts";

export interface Finding {
  readonly check: string;
  readonly severity: "error" | "warn";
  readonly message: string;
  readonly detail?: string;
}

export interface ReviewReport {
  /** Every finding from the automatic checks. */
  readonly findings: readonly Finding[];
  /** The check ids that ran. */
  readonly checked: readonly string[];
  /** Human-readable one-line per finding/fix, for the delivery summary. */
  readonly summary: readonly string[];
  /** True when the automatic checks found no `error`. */
  readonly passed: boolean;
  /** Whether a vision-model review ran (false = automatic checks only). */
  readonly vision: boolean;
}

export const CHECK_IDS = ["links", "images", "fonts", "contrast", "overflow", "widow", "empty-page"] as const;
export type CheckId = (typeof CHECK_IDS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// static checks (pure, on the assembled HTML)
// ---------------------------------------------------------------------------------------------------------------------

const HREF_RE = /<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi;

/** Broken links: `javascript:`/`file:` targets, malformed hrefs, and in-page `#fragment` targets that do not exist. */
export function checkLinks(html: string): Finding[] {
  const ids = new Set<string>();
  for (const m of html.matchAll(/\bid\s*=\s*"([^"]+)"/gi)) ids.add(m[1]!);
  const out: Finding[] = [];
  for (const m of html.matchAll(HREF_RE)) {
    const href = m[1]!;
    if (/^(javascript|file|data):/i.test(href)) {
      out.push({ check: "links", severity: "error", message: `unsafe link target ${href}`, detail: href });
    } else if (href.startsWith("#")) {
      if (!ids.has(href.slice(1))) out.push({ check: "links", severity: "warn", message: `fragment link to a missing target ${href}`, detail: href });
    } else if (!/^https?:\/\//i.test(href)) {
      out.push({ check: "links", severity: "warn", message: `unverifiable link target ${href}`, detail: href });
    }
  }
  return out;
}

const IMG_RE = /<img\b[^>]*>/gi;
const ATTR_RE = /(\b[a-z-]+)\s*=\s*"([^"]*)"/gi;

/** Images below 150 dpi at print size, and images with no intrinsic size to reason about. */
export function checkImages(html: string): Finding[] {
  const out: Finding[] = [];
  for (const tag of html.matchAll(IMG_RE)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(ATTR_RE)) attrs.set(a[1]!, a[2]!);
    const width = Number(attrs.get("width") ?? NaN);
    const height = Number(attrs.get("height") ?? NaN);
    const naturalW = Number(attrs.get("data-natural-width") ?? attrs.get("naturalwidth") ?? NaN);
    const src = attrs.get("src") ?? attrs.get("alt");
    if (!Number.isFinite(naturalW) || !Number.isFinite(width) || width <= 0) {
      out.push({ check: "images", severity: "warn", message: "image has no intrinsic pixel width to compute print dpi", ...(src !== undefined ? { detail: src } : {}) });
      continue;
    }
    // width/height are CSS px at 96 dpi CSS reference; print size in inches = px / 96.
    const inches = width / 96;
    const dpi = naturalW / inches;
    if (dpi < 150) out.push({ check: "images", severity: "error", message: `image is ${Math.round(dpi)} dpi at print size (below 150)`, ...(src !== undefined ? { detail: src } : {}) });
  }
  return out;
}

const FONT_FACE_FAMILY_RE = /@font-face\s*\{[^}]*font-family\s*:\s*"([^"]+)"/gi;
const FONT_USE_RE = /font-family\s*:\s*([^;}]+)/gi;

/** A font family referenced by the CSS but neither embedded via @font-face nor a system fallback. */
export function checkFonts(html: string): Finding[] {
  const embedded = new Set<string>();
  for (const m of html.matchAll(FONT_FACE_FAMILY_RE)) embedded.add(m[1]!);
  const SYSTEM = new Set(["system-ui", "-apple-system", "segoe ui", "roboto", "georgia", "times new roman", "ui-monospace", "sf mono", "menlo", "consolas", "monospace", "sans-serif", "serif", "cursive", "fantasy"]);
  const out: Finding[] = [];
  for (const m of html.matchAll(FONT_USE_RE)) {
    for (const fam of m[1]!.split(",")) {
      const name = fam.trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (!name || SYSTEM.has(name)) continue;
      if (!embedded.has(name)) out.push({ check: "fonts", severity: "error", message: `font family "${fam.trim()}" is used but not embedded and has no system fallback`, detail: fam.trim() });
    }
  }
  return out;
}

const STYLE_RE = /<[^>]+\bstyle\s*=\s*"([^"]*)"/gi;
const DECL_RE = /(^|;)\s*(color|background(?:-color)?)\s*:\s*([^;]+)/gi;

/** Inline colour pairs with a computed WCAG contrast below the body threshold (seeded contrast defects). */
export function checkInlineContrast(html: string): Finding[] {
  const out: Finding[] = [];
  for (const el of html.matchAll(STYLE_RE)) {
    const style = el[1]!;
    let fg: string | undefined;
    let bg: string | undefined;
    for (const d of style.matchAll(DECL_RE)) {
      const prop = d[2]!.toLowerCase();
      const value = d[3]!.trim();
      if (prop === "color") fg = value;
      else if (!bg) bg = value;
    }
    if (!fg || !bg) continue;
    try {
      const ratio = contrast(fg, bg);
      if (ratio < BODY_CONTRAST) {
        out.push({ check: "contrast", severity: "error", message: `inline text contrast ${ratio.toFixed(2)}:1 is below ${BODY_CONTRAST}:1 (${fg} on ${bg})`, detail: `${fg} on ${bg}` });
      }
    } catch { /* not a hex colour the checker can reason about; leave it to the vision pass */ }
  }
  return out;
}

/** All static checks, in a stable order. */
export function staticChecks(html: string): Finding[] {
  return [...checkLinks(html), ...checkImages(html), ...checkFonts(html), ...checkInlineContrast(html)];
}

// ---------------------------------------------------------------------------------------------------------------------
// layout checks (run inside the browser; the returned script must be evaluated against the rendered document)
// ---------------------------------------------------------------------------------------------------------------------

/** A JS expression returning an array of `{check, message, detail}` for overflow, widows and empty pages. */
export const LAYOUT_CHECK_SCRIPT = `(() => {
  const out = [];
  // text overflow: a block whose content is clipped or scrolled past its box
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const clips = cs.overflow === 'hidden' || cs.overflow === 'clip' || cs.textOverflow === 'ellipsis';
    if (clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
      out.push({ check: 'overflow', message: 'clipped or overflowing box', detail: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') });
    }
  }
  // widow: a paragraph whose last line carries a single word
  for (const p of document.querySelectorAll('p')) {
    const text = p.textContent.trim();
    const words = text.split(/\\s+/).filter(Boolean);
    if (words.length < 4) continue;
    const range = document.createRange();
    range.selectNodeContents(p);
    const rect = range.getBoundingClientRect();
    if (rect.height < 8) continue; // no meaningful lines
    const last = words[words.length - 1];
    const i = text.lastIndexOf(last);
    const r2 = document.createRange();
    r2.setStart(p.firstChild, i);
    r2.setEnd(p.firstChild, i + last.length);
    const prev = document.createRange();
    const j = text.lastIndexOf(words[words.length - 2]);
    prev.setStart(p.firstChild, j);
    prev.setEnd(p.firstChild, j + words[words.length - 2].length);
    if (Math.abs(r2.getBoundingClientRect().top - prev.getBoundingClientRect().top) > 4) {
      out.push({ check: 'widow', message: 'paragraph ends in a single-word line (widow)', detail: last });
    }
  }
  // empty page: two forced page breaks with no content between them (computed style, not attribute)
  const breaks = [...document.querySelectorAll('body *')].filter(el => {
    const cs = getComputedStyle(el);
    return cs.breakAfter === 'page' || cs.breakBefore === 'page';
  });
  for (let k = 0; k + 1 < breaks.length; k++) {
    const a = breaks[k], b = breaks[k + 1];
    if (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const between = document.createRange();
      between.setStartAfter(a);
      between.setEndBefore(b);
      if (!between.toString().trim() && between.cloneContents().querySelectorAll('img, table, figure').length === 0) {
        out.push({ check: 'empty-page', message: 'a forced page break is immediately followed by another (empty page)' });
      }
    }
  }
  return out;
})()`;

/** Whether a list of findings has no error-severity item. */
export function passedChecks(findings: readonly Finding[]): boolean {
  return findings.every((f) => f.severity !== "error");
}

/** A one-line summary per finding for the delivery report. */
export function summarize(findings: readonly Finding[], vision: boolean, fixed: readonly string[]): ReviewReport {
  const checked = [...CHECK_IDS];
  const summary = [
    ...findings.map((f) => `${f.check}: ${f.message}`),
    ...fixed.map((s) => `fixed: ${s}`),
    `vision review: ${vision ? "ran" : "not configured — automatic checks only"}`,
  ];
  return { findings, checked, summary, passed: passedChecks(findings), vision };
}


