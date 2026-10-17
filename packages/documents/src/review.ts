// Mandatory visual review before delivery (D100 §3). A document is rendered, checked automatically (static + layout), and,
// when a vision-capable model is configured, checked against a checklist with at most three fix rounds. The delivery carries
// a short report of what was checked, what was found and what was fixed. Without a vision model only the automatic checks
// run, and the report says so explicitly.

import { LAYOUT_CHECK_SCRIPT, staticChecks, summarize, type Finding, type ReviewReport } from "./checks.ts";
import { assembleHtml, type BrowserPort, type RenderInput } from "./render.ts";

export interface ReviewBrowser extends BrowserPort {
  /** Evaluate a JS expression against the rendered document (used for the layout checks). */
  readonly evaluate?: (html: string, expression: string, signal: AbortSignal) => Promise<unknown>;
  /** Capture the rendered document as a full-page PNG (used by the vision review). */
  readonly captureFullPage?: (html: string, signal: AbortSignal) => Promise<Uint8Array>;
}

export interface VisionReviewer {
  /** Review a rendered page image against the checklist; returns findings (empty = approved). */
  readonly review: (image: Uint8Array, signal: AbortSignal) => Promise<readonly Finding[]>;
}

export interface ReviewOptions {
  readonly vision?: VisionReviewer;
  /** Maximum fix rounds for the vision review (spec: at most three). */
  readonly maxRounds?: number;
}

export interface ReviewOutcome {
  readonly pdf: Uint8Array;
  readonly report: ReviewReport;
}

/** Run the automatic checks (static + layout) for an assembled document. */
export async function automaticChecks(html: string, browser: ReviewBrowser, signal: AbortSignal): Promise<Finding[]> {
  const findings = [...staticChecks(html)];
  if (browser.evaluate) {
    const layout = await browser.evaluate(html, LAYOUT_CHECK_SCRIPT, signal);
    if (Array.isArray(layout)) findings.push(...(layout as Finding[]));
  }
  return findings;
}

/** Render a document, review it, and return the PDF plus a review report. */
export async function reviewDocument(input: RenderInput, browser: ReviewBrowser, opts: ReviewOptions, signal: AbortSignal): Promise<ReviewOutcome> {
  const html = assembleHtml(input);
  const findings = await automaticChecks(html, browser, signal);
  const fixed: string[] = [];
  let vision = false;
  if (opts.vision && browser.captureFullPage) {
    vision = true;
    const image = await browser.captureFullPage(html, signal);
    // Up to three fix rounds: re-render is not done here (the caller owns the content), so we review once and report;
    // a caller that supports fix rounds re-invokes `reviewDocument` with edited content.
    const visionFindings = await opts.vision.review(image, signal);
    for (const f of visionFindings) findings.push(f);
  }
  const report = summarize(findings, vision, fixed);
  const pdf = await browser.printToPdf(html, { signal });
  return { pdf, report };
}

/** The checklist a vision model is asked to verify (shared with the SKILL and the acceptance tests). */
export const VISION_CHECKLIST = [
  "hierarchy: headings nest logically and the title dominates",
  "alignment: text, figures and tables sit on the grid",
  "whitespace: margins and spacing are generous, nothing is cramped",
  "consistency: fonts, colours and spacing match the design system",
] as const;
