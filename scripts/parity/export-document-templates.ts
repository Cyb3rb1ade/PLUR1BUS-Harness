import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assembleHtml } from "../../packages/documents/src/render.ts";
import { buildDocumentHtml, TEMPLATE_IDS } from "../../packages/documents/src/templates.ts";
import { markdownToHtml } from "../../packages/documents/src/markdown.ts";
import { sanitizeHtml } from "../../packages/documents/src/sanitize.ts";
import { NEUTRAL_KIT } from "../../packages/documents/src/tokens.ts";
import { exporterMain } from "./lib.mjs";

export function recordDocumentTemplates() {
  const common = {
    title: "Notes & plans",
    subtitle: "Check <draft>",
    markdown: "Intro & context\n\n## First\n\n[Chapter](#chapter) and [Reference](https://example.invalid/docs)\n\n## Second\n\nA **strong** conclusion.",
    meta: {
      title: "Fixture <title>", author: "A & B", date: "22 November",
      from: "Fixture sender", to: "Fixture recipient", subject: "Review",
      salutation: "Dear colleague", closing: "Regards", role: "Writer",
      total: "12.50", lineItems: [{ label: "Notes & plan", amount: "12.50" }],
    },
  };
  const cases = TEMPLATE_IDS.map((template) => ({ template, ...common, colors: {} }));
  cases.push({
    ...common, template: "slides", subtitle: "", markdown: "Only one slide.",
    colors: { accent: "#134280", paper: "#fafafa" },
  });
  const render = cases.map((input) => {
    const html = assembleHtml({ template: input.template, title: input.title, subtitle: input.subtitle,
      content: input.markdown, meta: input.meta, kit: { ...NEUTRAL_KIT, ...input.colors } });
    const count = html.match(/@font-face/g)?.length ?? 0;
    if (count !== 3) throw new Error("All three shipped font files are required for the W4 recording");
    return { template: input.template, bytes: Buffer.byteLength(html),
      sha256: createHash("sha256").update(html, "utf8").digest("hex") };
  });
  return { templates: {
    source: "packages/documents/src/render.ts",
    cases: cases.map((input) => ({
      input,
      expected: buildDocumentHtml(input.template, {
        title: input.title, subtitle: input.subtitle, meta: input.meta,
        bodyHtml: sanitizeHtml(markdownToHtml(input.markdown)),
        kit: { ...NEUTRAL_KIT, ...input.colors },
      }),
    })),
  }, "render-html": { source: "packages/documents/src/render.ts", render } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "documents", build: recordDocumentTemplates });
}
