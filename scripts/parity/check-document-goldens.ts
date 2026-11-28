import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLES } from "../../packages/documents/scripts/golden-samples.ts";
import { diffPng } from "../../packages/documents/scripts/png-diff.ts";
import { assembleHtml, createChromiumBrowser, TEMPLATE_IDS } from "../../packages/documents/src/index.ts";

const browserPath = process.env.PLUR1BUS_CHROMIUM_BIN;
const rendererPath = process.env.PLUR1BUS_DOC_GOLDEN_RENDERER;
const outDirectory = process.env.PLUR1BUS_GOLDEN_OUT;
assert.ok(browserPath && rendererPath && outDirectory,
  "Set PLUR1BUS_CHROMIUM_BIN, PLUR1BUS_DOC_GOLDEN_RENDERER and PLUR1BUS_GOLDEN_OUT");
const sameBrowser = process.argv.slice(2).includes("--same-browser");
const golden = fileURLToPath(new URL("../../packages/documents/golden/", import.meta.url));
const fonts = fileURLToPath(new URL("../../packages/documents/assets/fonts/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(golden, "manifest.json"), "utf8")) as {
  chrome: string;
  threshold: { channelTolerance: number; maxDiffRatio: number };
};
const version = spawnSync(browserPath, ["--version"], { encoding: "utf8", timeout: 15000 });
assert.equal(version.status, 0);
const actualChrome = version.stdout.trim();
if (!sameBrowser) assert.equal(actualChrome, manifest.chrome);
const output = resolve(outDirectory);
mkdirSync(output, { recursive: true });
const requests = TEMPLATE_IDS.map((template) => ({
  template, title: "Golden Document", subtitle: "A subtitle", ...SAMPLES[template],
}));
const rendered = spawnSync(rendererPath, [resolve(browserPath), fonts, output], {
  encoding: "utf8", input: JSON.stringify(requests), timeout: 180000,
});
assert.equal(rendered.status, 0, rendered.error?.message ?? rendered.stderr);
const browser = createChromiumBrowser({ bin: browserPath }) as ReturnType<typeof createChromiumBrowser> & {
  captureFullPage(html: string, signal: AbortSignal): Promise<Uint8Array>;
};
function pages(data: Uint8Array): number {
  const text = Buffer.from(data).toString("latin1");
  assert.ok(text.startsWith("%PDF-") && text.includes("%%EOF") && text.includes("Inter"));
  return Array.from(text.matchAll(/\/Type\s*\/Page\b/g)).length;
}
for (const request of requests) {
  const { template } = request;
  const html = assembleHtml(request);
  const pdf = await browser.printToPdf(html, { signal: AbortSignal.timeout(30000) });
  const pdfPages = pages(readFileSync(join(output, template + ".pdf")));
  assert.ok(pdfPages > 0, template + " PDF has no pages");
  assert.equal(pdfPages, pages(pdf), template + " print page count");
  const expected = sameBrowser
    ? Buffer.from(await browser.captureFullPage(html, AbortSignal.timeout(30000)))
    : readFileSync(join(golden, template + ".png"));
  const diff = diffPng(expected, readFileSync(join(output, template + ".png")), {
    tolerance: manifest.threshold.channelTolerance, maxRatio: manifest.threshold.maxDiffRatio,
  });
  assert.ok(diff.ok, template + " visual difference " + JSON.stringify(diff));
  console.log(template + " PDF pages=" + pdfPages + ", changed pixels=" + diff.differing + "/" + diff.total);
}
console.log("Chromium " + actualChrome + (sameBrowser ? ", same-browser TypeScript references" : ", committed document goldens"));
