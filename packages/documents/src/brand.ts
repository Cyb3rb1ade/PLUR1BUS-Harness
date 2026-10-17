// Brand kit (D100 §4): logo, colours, fonts and tone stored once per installation/project and applied everywhere. Without a
// kit the neutral PLUR1BUS kit is used. A kit's colours are re-checked against WCAG AA on load; a pair that misses the floor
// produces a warning and a concrete suggestion instead of silently rendering. Logos are image bytes only (magic-byte check and
// a size limit); SVG is either sanitised to a script-free subset or rejected.

import { BODY_CONTRAST, LARGE_TEXT_CONTRAST, NEUTRAL_KIT, contrast, parseHex, type NeutralKit } from "./tokens.ts";

export type BrandColorKey = keyof NeutralKit;

export interface BrandKit {
  readonly name: string;
  /** Optional logo image (PNG/JPEG/WebP bytes; no script). */
  readonly logo?: Uint8Array;
  /** Overrides for the neutral kit tokens (partial). */
  readonly colors: Partial<Record<BrandColorKey, string>>;
  /** Font family overrides (names only; the renderer embeds the faces it knows). */
  readonly fonts?: { sans?: string; serif?: string; mono?: string };
  /** One-line tone guidance (e.g. "professional and concise"). */
  readonly tone?: string;
}

export interface BrandIssue {
  readonly severity: "error" | "warn";
  readonly field: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface BrandValidation {
  readonly ok: boolean;
  readonly issues: readonly BrandIssue[];
  /** The effective kit: neutral tokens overlaid with the validated overrides. */
  readonly kit: NeutralKit;
}

const HEX_RE = /^#[0-9a-f]{3,8}$/i;

/** Darken a hex colour by moving each channel toward zero until `fg` clears `minimum` against `bg`. */
export function suggestContrast(fg: string, bg: string, minimum: number): string {
  const target = parseHex(bg);
  const rl = relativeLum(target);
  // Lighter background → darken foreground; darker background → lighten foreground.
  const lighten = rl < 0.5;
  const f = parseHex(fg);
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  for (const step of [0, 8, 16, 24, 32, 48, 64, 96, 128]) {
    const adj = lighten ? step : -step;
    const candidate = { r: clamp(f.r + adj), g: clamp(f.g + adj), b: clamp(f.b + adj) };
    const hex = `#${[candidate.r, candidate.g, candidate.b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    if (contrast(hex, bg) >= minimum) return hex;
  }
  return lighten ? "#ffffff" : "#000000";
}

function relativeLum(c: { r: number; g: number; b: number }): number {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

const LOGO_MAGIC: readonly { kind: string; bytes: readonly number[] }[] = [
  { kind: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { kind: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { kind: "webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" (container; format checked below)
];

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Validate a logo image: a known raster format (magic bytes) within the size limit. Returns an error string, else null. */
export function validateLogo(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return "logo is empty";
  if (bytes.byteLength > MAX_LOGO_BYTES) return `logo is ${bytes.byteLength} bytes (limit ${MAX_LOGO_BYTES})`;
  const head = [...bytes.subarray(0, 12)];
  for (const { kind, bytes: magic } of LOGO_MAGIC) {
    if (magic.every((b, i) => head[i] === b)) {
      if (kind === "webp" && !(head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50)) {
        return "RIFF container is not WEBP";
      }
      return null;
    }
  }
  return "logo is not a PNG, JPEG or WebP image (SVG is sanitised or rejected, never loaded as-is)";
}

/** Sanitise an SVG logo to a script-free subset, or return null when it cannot be made safe. */
export function sanitizeSvg(svg: string): string | null {
  if (!/^\s*<svg[\s>]/i.test(svg)) return null;
  let out = svg.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "");
  if (/<\s*script/i.test(out)) return null;
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/\s(href|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m) => (/javascript:|data:|https?:/i.test(m) ? "" : m));
  return /<\s*script|on[a-z]+\s*=|javascript:/i.test(out) ? null : out;
}

/** Validate a full brand kit and produce the effective (neutral-overlaid) kit plus issues and contrast suggestions. */
export function validateBrandKit(brand: BrandKit): BrandValidation {
  const issues: BrandIssue[] = [];
  const kit: NeutralKit = { ...NEUTRAL_KIT };
  for (const [k, v] of Object.entries(brand.colors)) {
    const key = k as BrandColorKey;
    if (!(key in NEUTRAL_KIT)) {
      issues.push({ severity: "warn", field: key, message: `unknown colour token ${key}` });
      continue;
    }
    if (typeof v !== "string" || !HEX_RE.test(v)) {
      issues.push({ severity: "error", field: key, message: `colour ${key} must be a hex colour` });
      continue;
    }
    kit[key] = v as NeutralKit[BrandColorKey];
  }
  const pairs: [BrandColorKey, BrandColorKey, number][] = [
    ["text", "paper", BODY_CONTRAST],
    ["muted", "paper", BODY_CONTRAST],
    ["accent", "paper", LARGE_TEXT_CONTRAST],
    ["on-accent", "accent", BODY_CONTRAST],
    ["cover-light-text", "cover-light-ground", BODY_CONTRAST],
    ["cover-dark-text", "cover-dark-ground", BODY_CONTRAST],
  ];
  for (const [fg, bg, min] of pairs) {
    const ratio = contrast(kit[fg], kit[bg]);
    if (ratio < min) {
      const suggestion = suggestContrast(kit[fg], kit[bg], min);
      issues.push({ severity: "warn", field: `${fg} on ${bg}`, message: `contrast ${ratio.toFixed(2)}:1 is below ${min}:1`, suggestion });
    }
  }
  if (brand.logo) {
    const err = validateLogo(brand.logo);
    if (err) issues.push({ severity: "error", field: "logo", message: err });
  }
  const ok = !issues.some((i) => i.severity === "error");
  return { ok, issues, kit };
}

/** The effective kit for a brand: neutral defaults overlaid with the brand's overrides (validated). */
export function resolveBrandKit(brand: BrandKit | undefined): NeutralKit {
  if (!brand) return NEUTRAL_KIT;
  const { kit } = validateBrandKit(brand);
  return kit;
}
