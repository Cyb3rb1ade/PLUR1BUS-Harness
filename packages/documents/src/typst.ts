// Typst, the second engine (D100 §2): math-heavy or very long documents render through the external `typst` binary when it is
// installed, with the same tokens and a report template counterpart. Typst is never bundled. Without the binary the renderer
// returns a clear reason and the caller falls back to the HTML engine (Chromium).

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEUTRAL_KIT, type NeutralKit } from "./tokens.ts";

export interface TypstInput {
  readonly title: string;
  readonly subtitle?: string;
  readonly author?: string;
  /** The document body as plain text (Typst markup; the caller is responsible for escaping). */
  readonly body: string;
  readonly kit?: NeutralKit;
}

/** A report template counterpart in Typst, using the kit tokens (same palette/type as the HTML templates). */
export function typstTemplate(input: TypstInput): string {
  const kit = input.kit ?? NEUTRAL_KIT;
  const accent = rgb(kit.accent);
  const text = rgb(kit.text);
  const muted = rgb(kit.muted);
  const paper = rgb(kit.paper);
  return `#set page(paper: "a4", margin: (x: 16mm, top: 20mm, bottom: 22mm), fill: ${paper})
#set text(font: "Source Serif 4", size: 11pt, fill: ${text})
#set heading(numbering: "1.1", fill: ${text})
#set par(justify: true)

#align(center)[
  #text(size: 28pt, font: "Inter", fill: ${accent})[${esc(input.title)}]
  #v(0.4em)
  #text(size: 12pt, fill: ${muted})[${esc(input.subtitle ?? "")}]
  #v(0.4em)
  #text(size: 10pt, fill: ${muted})[${esc(input.author ?? "")}]
]

#v(1em)
${input.body}
`;
}

function esc(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("#", "\\#").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/** A kit hex colour as Typst `rgb("#rrggbb")`. */
function rgb(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return `rgb("#${full.padEnd(6, "0").slice(0, 6)}")`;
}

export interface TypstResult {
  readonly available: boolean;
  readonly pdf?: Uint8Array;
  /** Why Typst was unavailable (clear message for the delivery). */
  readonly reason?: string;
}

export interface TypstOptions {
  readonly bin?: string;
}

/** Resolve the Typst binary path, or null when not installed. */
export function findTypst(bin = "typst"): string | null {
  try { accessSync(bin, constants.X_OK); return bin; } catch { return null; }
}

/** Render a Typst document to PDF via the external binary; `available: false` (with a reason) when it is not installed. */
export async function renderTypst(source: string, opts: TypstOptions, signal: AbortSignal): Promise<TypstResult> {
  const bin = findTypst(opts.bin);
  if (!bin) return { available: false, reason: "the typst binary is not installed" };
  if (signal.aborted) return { available: false, reason: "aborted" };
  const dir = await mkdtemp(join(tmpdir(), "plur1bus-typst-"));
  try {
    const src = join(dir, "document.typ");
    const out = join(dir, "document.pdf");
    await writeFile(src, source, "utf8");
    const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      const child = spawn(bin, ["compile", src, out], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (c: string) => (err += c));
      child.on("error", (e) => resolve({ ok: false, message: e.message }));
      child.on("exit", (code) => resolve({ ok: code === 0, message: code === 0 ? "" : err.trim() || `typst exited ${code}` }));
    });
    if (!result.ok) return { available: false, reason: result.message || "typst compile failed" };
    return { available: true, pdf: new Uint8Array(await readFile(out)) };
  } finally {
    // best-effort cleanup
    await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }).catch(() => {}));
  }
}

/** Render a report through Typst when available, otherwise a clear fallback reason. */
export async function renderReportTypst(input: TypstInput, opts: TypstOptions, signal: AbortSignal): Promise<TypstResult> {
  return await renderTypst(typstTemplate(input), opts, signal);
}
