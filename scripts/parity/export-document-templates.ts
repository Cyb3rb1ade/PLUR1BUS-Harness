import { fileURLToPath } from "node:url";
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
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "documents", build: recordDocumentTemplates });
}
