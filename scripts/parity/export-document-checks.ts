import { fileURLToPath } from "node:url";
import { LAYOUT_CHECK_SCRIPT, staticChecks, summarize } from "../../packages/documents/src/checks.ts";
import { exporterMain } from "./lib.mjs";

export function recordDocumentChecks() {
  const html = [
    '<style>@font-face { font-family: "Inter"; src: url(data:font/ttf;base64,AAAA) }',
    '.sample { font-family: "Inter", "Fixture Sans", system-ui; }</style>',
    '<a id="available" href="#available">Present</a>',
    '<a href="#missing">Missing</a><a href="terms">Terms</a>',
    '<img alt="cover"><img alt="figure" width="192" data-natural-width="200">',
    '<p style="color:#777;background-color:#fff">Low contrast text</p>',
    '<p style="color:#000;background-color:#fff">High contrast text</p>',
  ].join("\n");
  const observed = staticChecks(html);
  const fontCase = (finding: typeof observed[number]) =>
    finding.check === "fonts" && finding.detail === '"Inter"';
  if (!observed.some(fontCase)) throw new Error("P4D-221 no longer reproduces");
  const fixed = ["Substituted a local font"];
  return { checks: {
    input: { html, fixed: ["Substituted a local font"], vision: false,
      layoutHtml: "<!doctype html><p>A short paragraph with <b>inline emphasis</b> and a plain end.</p>" },
    observed: summarize(observed, false, fixed),
    "expected-divergence": "P4D-221",
    result: summarize(observed.filter((finding) => !fontCase(finding)), false, fixed),
    layoutExpectedDivergence: "P4D-222",
    layoutScript: LAYOUT_CHECK_SCRIPT,
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "documents", build: recordDocumentChecks });
}
