// The document design system's colour tokens (D100 §1). Each token pair that a template uses for body text must meet
// WCAG AA 4.5:1, and each large-text / heading pair 3:1. Contrast is COMPUTED here from the sRGB values, never hand-waved;
// `packages/documents/test/tokens.test.ts` computes the ratio of every declared pair and fails below the threshold.
//
// The neutral "PLUR1BUS" kit is the fallback when no brand kit is configured (D100 §4); the Brand page (Phase 3) replaces
// these values per installation/project and re-runs the same contrast check before rendering.

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A CSS hex colour like `#2563eb` or `#fff`. */
export type Hex = string;

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` into 0–255 components. */
export function parseHex(hex: string): Rgb {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  const ok = /^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  if (!ok.test(h)) throw new Error(`not a hex colour: ${hex}`);
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) throw new Error(`not a hex colour: ${hex}`);
  return { r, g, b };
}

/** A single sRGB channel linearised (WCAG 2.x). */
function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Relative luminance in the 0..1 range (WCAG 2.x, sRGB). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG 2.x contrast ratio in the 1..21 range (order-independent). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function contrast(hexA: Hex, hexB: Hex): number {
  return contrastRatio(parseHex(hexA), parseHex(hexB));
}

/** WCAG AA thresholds the design system enforces. */
export const BODY_CONTRAST = 4.5;
export const LARGE_TEXT_CONTRAST = 3.0;

/**
 * The neutral PLUR1BUS colour tokens. `text` and `muted` are body colours (must clear 4.5:1 on `paper` and `cover-dark`);
 * `accent` is used for large headings, links and pull quotes on `paper` (must clear 4.5:1 for links/body use; the contrast
 * test additionally asserts the >=3:1 large-text floor). Every value is a plain hex so it can be re-emitted as CSS variables.
 */
export const NEUTRAL_KIT = {
  /** Body background. */
  paper: "#ffffff",
  /** Primary text on paper. */
  text: "#1a1c20",
  /** Secondary text (captions, footnotes) on paper — still body-sized, so still 4.5:1. */
  muted: "#4b5563",
  /** Accent (headings, links, rules). */
  accent: "#2563eb",
  /** Text placed on the accent (buttons/labels on an accent ground). */
  "on-accent": "#ffffff",
  /** Light cover: text/headline on the accent ground. */
  "cover-light-text": "#ffffff",
  "cover-light-ground": "#2563eb",
  /** Dark cover: light text on a near-black ground. */
  "cover-dark-text": "#f5f7fa",
  "cover-dark-ground": "#111827",
} as const;

export type NeutralKit = typeof NEUTRAL_KIT;

/** A declared contrast requirement between two tokens (or a token and a literal colour). */
export interface ContrastRequirement {
  readonly foreground: string;
  readonly background: string;
  readonly minimum: number;
  readonly label: string;
}

/** The pairs the neutral kit must clear. The test computes each ratio from the hex values. */
export const NEUTRAL_REQUIREMENTS: readonly ContrastRequirement[] = [
  { foreground: "text", background: "paper", minimum: BODY_CONTRAST, label: "body text on paper" },
  { foreground: "muted", background: "paper", minimum: BODY_CONTRAST, label: "muted/caption text on paper" },
  { foreground: "accent", background: "paper", minimum: LARGE_TEXT_CONTRAST, label: "accent on paper (large)" },
  { foreground: "on-accent", background: "accent", minimum: BODY_CONTRAST, label: "text on accent" },
  { foreground: "cover-light-text", background: "cover-light-ground", minimum: BODY_CONTRAST, label: "light cover text on accent" },
  { foreground: "cover-dark-text", background: "cover-dark-ground", minimum: BODY_CONTRAST, label: "dark cover text on ground" },
];

/** Resolve a token name (or a literal `#…` colour) against the neutral kit. */
export function resolveToken(kit: NeutralKit, nameOrHex: string): Rgb {
  if (nameOrHex in kit) return parseHex(kit[nameOrHex as keyof NeutralKit] as string);
  return parseHex(nameOrHex);
}

/** Compute the ratio of one declared requirement against a kit. */
export function requirementRatio(kit: NeutralKit, req: ContrastRequirement): number {
  return contrastRatio(resolveToken(kit, req.foreground), resolveToken(kit, req.background));
}

/** Serialise a kit to CSS custom properties (`--doc-paper: …;`), one per line. */
export function kitToCssVariables(kit: NeutralKit, prefix = "doc"): string {
  return Object.entries(kit)
    .map(([k, v]) => `  --${prefix}-${k}: ${v};`)
    .join("\n");
}
