// HTML → PDF rendering (D100 §2). The renderer assembles a self-contained document — inline design-system CSS, the agent's
// Markdown rendered to escaped HTML and re-sanitised — and hands it to a `BrowserPort` that runs Chromium's `Page.printToPDF`.
// The browser port is injected so tests can substitute a fake and assert on the exact HTML without a real Chromium; the
// default port drives the CDP client in `chromium.ts`.

import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPage, printToPdf, removeDir } from "./chromium.ts";
import { fontFaces } from "./fonts.ts";
import { markdownToHtml } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";
import { buildDocumentHtml, TEMPLATE_IDS, type DocumentMeta, type TemplateId } from "./templates.ts";
import { NEUTRAL_KIT, type NeutralKit } from "./tokens.ts";

export interface BrowserPort {
  /** Render a full HTML document to a PDF (Chromium `Page.printToPDF`). Must be given self-contained HTML. */
  printToPdf(html: string, opts: { signal: AbortSignal }): Promise<Uint8Array>;
}

export interface RenderInput {
  readonly template: TemplateId;
  /** The agent's Markdown content (untrusted: escaped and sanitised). */
  readonly content: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly meta?: DocumentMeta;
  readonly kit?: NeutralKit;
}

export interface RenderResult {
  readonly pdf: Uint8Array;
  readonly html: string;
}

export function isTemplateId(v: unknown): v is TemplateId {
  return typeof v === "string" && (TEMPLATE_IDS as readonly string[]).includes(v);
}

/**
 * Assemble the self-contained HTML for a template + content. Exposed for tests: it must contain no `<script>` injected from
 * content, no `http(s)://` or `//` external resource reference, and no `file:` reference outside the render roots.
 */
export function assembleHtml(input: RenderInput): string {
  const bodyHtml = sanitizeHtml(markdownToHtml(input.content));
  const html = buildDocumentHtml(input.template, {
    title: input.title,
    subtitle: input.subtitle ?? "",
    bodyHtml,
    meta: input.meta ?? {},
    kit: input.kit ?? NEUTRAL_KIT,
  });
  // Embed the OFL faces (data: URLs) before the base stylesheet; no external font fetch, fonts travel into the PDF.
  return html.replace("<style>", `<style>\n${fontFaces()}\n`);
}

/** Render a document to PDF bytes. */
export async function renderDocument(input: RenderInput, browser: BrowserPort, signal: AbortSignal): Promise<RenderResult> {
  const html = assembleHtml(input);
  const pdf = await browser.printToPdf(html, { signal });
  return { pdf, html };
}

// ---------------------------------------------------------------------------------------------------------------------
// Default browser port (real Chromium)
// ---------------------------------------------------------------------------------------------------------------------

export interface ChromiumBrowserOptions {
  /** Path to a Chromium/Chrome binary. */
  readonly bin: string;
}

/** A browser port that renders via a real Chromium binary (CDP `Page.printToPDF`). */
export function createChromiumBrowser(opts: ChromiumBrowserOptions): BrowserPort {
  return {
    async printToPdf(html, { signal }) {
      const dir = await mkdtemp(join(tmpdir(), "plur1bus-doc-"));
      try {
        const htmlPath = join(dir, "document.html");
        await writeFile(htmlPath, html, "utf8");
        const { cdp, launch } = await openPage(opts.bin, `file://${htmlPath}`, signal);
        try {
          return await printToPdf(cdp, signal);
        } finally {
          cdp.close();
          await launch.close();
        }
      } finally {
        await removeDir(dir);
      }
    },
  };
}
