// Golden set (D100 §5): render one document per template to a PNG and compare against approved reference images. The fonts are
// embedded and the content is fixed, so a render is deterministic; the diff threshold is byte-identical PNGs (SHA-256), the
// strictest threshold. Run with `node --experimental-strip-types --conditions=source packages/documents/scripts/golden.ts <generate|check>`.
//
// `generate` writes `packages/documents/golden/<template>.png` and a `manifest.json`; `check` re-renders and compares, exiting
// non-zero on any mismatch. The reference PNGs are small (one page each) and committed.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

async function renderAll(browser: ReturnType<typeof createChromiumBrowser>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const template of TEMPLATE_IDS) {
    const s = SAMPLES[template];
    const html = assembleHtml({ template, content: s.content, title: "Golden Document", subtitle: "A subtitle", meta: s.meta });
    const png = await (browser as unknown as { captureFullPage: (html: string, signal: AbortSignal) => Promise<Uint8Array> }).captureFullPage(html, new AbortController().signal);
    out[template] = createHash("sha256").update(Buffer.from(png)).digest("hex");
    const file = join(GOLDEN_DIR, `${template}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
  }
  return out;
}

const mode = process.argv[2] ?? "check";
const browser = createChromiumBrowser({ bin: findChromium() });

if (mode === "generate") {
  const hashes = await renderAll(browser);
  writeFileSync(MANIFEST, JSON.stringify({ threshold: "sha256-exact", hashes }, null, 2) + "\n");
  console.log(`golden set generated: ${Object.keys(hashes).length} references in ${GOLDEN_DIR}`);
} else {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { threshold: string; hashes: Record<string, string> };
  const current = await renderAll(browser);
  const failures: string[] = [];
  for (const template of TEMPLATE_IDS) {
    if (manifest.hashes[template] !== current[template]) failures.push(template);
  }
  if (failures.length) {
    console.error(`golden set mismatch (threshold: ${manifest.threshold}): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(`golden set ok: ${TEMPLATE_IDS.length} references match (threshold: ${manifest.threshold})`);
}
