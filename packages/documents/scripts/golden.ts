// Golden set (D100 §5): render one document per template to a PNG and compare against approved reference images. The fonts are
// embedded and the content is fixed, but byte-identical PNGs are not stable across Chrome versions or machines, so the images are
// compared pixel-wise against a documented threshold (png-diff.ts: per-channel tolerance, max share of differing pixels per page).
// References are produced by the Chrome version pinned in the `documents-golden` CI job, never locally.
//
//   golden.ts check [--out <dir>]    render, write the renders (+ render-info.json) to <dir> (default: $PLUR1BUS_GOLDEN_OUT or the
//                                    OS temp dir), diff against golden/, exit 1 on any page over the threshold. Never touches golden/.
//   golden.ts update --from <dir>    adopt the renders of a CI run (downloaded artifact) as the new references.
//   golden.ts update                 manual mode: render with the local Chrome (PLUR1BUS_CHROMIUM_BIN) straight into golden/.
// Run with `node --experimental-strip-types --conditions=source packages/documents/scripts/golden.ts <mode>`.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_TOLERANCE, decodePng, diffPng, MAX_DIFF_RATIO } from "./png-diff.ts";
import { assembleHtml, createChromiumBrowser, TEMPLATE_IDS, type TemplateId } from "../src/index.ts";

const GOLDEN_DIR = fileURLToPath(new URL("../golden/", import.meta.url));
const MANIFEST = join(GOLDEN_DIR, "manifest.json");

const SAMPLES: Record<TemplateId, { content: string; meta: Record<string, unknown> }> = {
  report: { content: "# Overview\n\nA quarterly report body.\n\n## Findings\n\n- one\n- two\n\n## Recommendations\n\nNext steps.\n", meta: { author: "A. Author", date: "2026-10-15" } },
  essay: { content: "# On Agency-Grade Documents\n\nAn essay body with several paragraphs of argument.\n\n## The argument\n\nDocuments must be designed, rendered and checked.\n", meta: {} },
  "white-paper": { content: "# A White Paper\n\nExecutive summary.\n\n## Findings\n\nNumbered findings.\n", meta: { author: "A. Author" } },
  proposal: { content: "# Proposal\n\nSummary of the engagement.\n\n## Scope\n\nIn scope.\n\n## Pricing\n\nFixed fee.\n", meta: { author: "A. Author" } },
  "one-pager": { content: "# One Pager\n\nA single-page summary of the work.\n", meta: {} },
  letter: { content: "Body of the letter.\n\nSincerely,\n", meta: { from: "Sender", to: "Recipient", date: "2026-10-15", subject: "Re: documents", salutation: "Dear Reader,", closing: "Best regards,", author: "A. Author" } },
  invoice: { content: "Notes for the client.\n", meta: { title: "Invoice", from: "Seller", to: "Buyer", date: "2026-10-15", total: "€ 1.000", lineItems: [{ label: "Work", amount: "€ 1.000" }] } },
  cv: { content: "## Experience\n\nRole and impact.\n\n## Skills\n\nListed.\n", meta: { title: "A. Author", role: "Engineer", author: "a@example.com" } },
  slides: { content: "## Slide one\n\nPoint one.\n\n## Slide two\n\nPoint two.\n", meta: {} },
};

function findChromium(): string {
  const env = process.env.PLUR1BUS_CHROMIUM_BIN;
  if (env) return env;
  for (const c of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/opt/homebrew/bin/google-chrome"]) {
    if (existsSync(c)) return c;
  }
  throw new Error("no Chromium binary; set PLUR1BUS_CHROMIUM_BIN");
}

function chromeVersion(bin: string): string {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return (r.stdout ?? "").trim() || "unknown";
}

/** Render every template into `dir` as `<template>.png`. */
async function renderAll(browser: ReturnType<typeof createChromiumBrowser>, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const template of TEMPLATE_IDS) {
    const s = SAMPLES[template];
    const html = assembleHtml({ template, content: s.content, title: "Golden Document", subtitle: "A subtitle", meta: s.meta });
    const png = await (browser as unknown as { captureFullPage: (html: string, signal: AbortSignal) => Promise<Uint8Array> }).captureFullPage(html, new AbortController().signal);
    writeFileSync(join(dir, `${template}.png`), png);
  }
}

function writeManifest(chrome: string): void {
  const manifest = { threshold: { channelTolerance: CHANNEL_TOLERANCE, maxDiffRatio: MAX_DIFF_RATIO }, chrome, templates: [...TEMPLATE_IDS] };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}

const args = process.argv.slice(2);
const mode = args[0] ?? "check";
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (mode === "update" && opt("--from")) {
  const from = resolve(opt("--from")!);
  const info = JSON.parse(readFileSync(join(from, "render-info.json"), "utf8")) as { chrome: string };
  mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const template of TEMPLATE_IDS) {
    const src = join(from, `${template}.png`);
    decodePng(readFileSync(src)); // refuses anything that is not a decodable PNG
    copyFileSync(src, join(GOLDEN_DIR, `${template}.png`));
  }
  writeManifest(info.chrome);
  console.log(`golden set updated from ${from}: ${TEMPLATE_IDS.length} references (${info.chrome})`);
} else if (mode === "update") {
  const bin = findChromium();
  await renderAll(createChromiumBrowser({ bin }), GOLDEN_DIR);
  writeManifest(chromeVersion(bin));
  console.log(`golden set rendered locally into ${GOLDEN_DIR} (${chromeVersion(bin)}); prefer references from the pinned CI Chrome`);
} else if (mode === "check") {
  const bin = findChromium();
  const out = resolve(opt("--out") ?? process.env.PLUR1BUS_GOLDEN_OUT ?? join(tmpdir(), "plur1bus-golden-out"));
  const chrome = chromeVersion(bin);
  await renderAll(createChromiumBrowser({ bin }), out);
  writeFileSync(join(out, "render-info.json"), JSON.stringify({ chrome }, null, 2) + "\n");
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { threshold: { channelTolerance: number; maxDiffRatio: number }; chrome: string };
  if (manifest.chrome !== chrome) console.warn(`note: references were rendered by "${manifest.chrome}", this run uses "${chrome}"`);
  const failures: string[] = [];
  for (const template of TEMPLATE_IDS) {
    const r = diffPng(readFileSync(join(GOLDEN_DIR, `${template}.png`)), readFileSync(join(out, `${template}.png`)), { tolerance: manifest.threshold.channelTolerance, maxRatio: manifest.threshold.maxDiffRatio });
    console.log(`${r.ok ? "ok  " : "FAIL"} ${template}: ${r.sizeMismatch ? "size changed" : `${r.differing}/${r.total} px differ (${(r.ratio * 100).toFixed(4)} %)`}`);
    if (!r.ok) failures.push(template);
  }
  const t = `tolerance ${manifest.threshold.channelTolerance}/255 per channel, max ${manifest.threshold.maxDiffRatio * 100} % differing pixels per page`;
  if (failures.length) {
    console.error(`golden set mismatch (${t}): ${failures.join(", ")}; renders in ${out}`);
    process.exit(1);
  }
  console.log(`golden set ok: ${TEMPLATE_IDS.length} references match (${t})`);
} else {
  console.error("usage: golden.ts <check [--out dir] | update [--from dir]>");
  process.exit(2);
}
