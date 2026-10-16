// Font embedding (D100 §1/§2): the three SIL OFL families are shipped as assets and embedded into the rendered document
// as `data:` URLs, so the PDF embeds the real faces, is self-contained, and never fetches anything from the network. When
// an asset is missing (a partial checkout), the `@font-face` is skipped and the CSS falls back to the system faces.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FONT_DIR = fileURLToPath(new URL("../assets/fonts/", import.meta.url));

const FAMILIES = [
  { family: "Inter", file: "Inter.ttf", weight: "100 900" },
  { family: "Source Serif 4", file: "SourceSerif4.ttf", weight: "200 900" },
  { family: "JetBrains Mono", file: "JetBrainsMono.ttf", weight: "100 800" },
] as const;

/** Whether at least one of the shipped font files is present. */
export function hasEmbeddedFonts(): boolean {
  return FAMILIES.some((f) => existsSync(join(FONT_DIR, f.file)));
}

/** `@font-face` rules with the shipped faces as `data:` URLs (empty when no asset is present). */
export function fontFaces(): string {
  const out: string[] = [];
  for (const f of FAMILIES) {
    const path = join(FONT_DIR, f.file);
    if (!existsSync(path)) continue;
    const b64 = readFileSync(path).toString("base64");
    out.push(
      `@font-face { font-family: "${f.family}"; font-style: normal; font-weight: ${f.weight}; src: url(data:font/ttf;base64,${b64}) format("truetype"); font-display: block; }`,
    );
  }
  return out.join("\n");
}
