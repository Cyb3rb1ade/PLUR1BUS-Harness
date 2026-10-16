// The `document.render` tool's input contract (D100 §1). The tool renders the agent's Markdown content through a named
// template to a PDF and writes it to `outputPath`, which the dispatcher's policy confines to the granted roots (the same
// path rule as `fs.write`). The schema lives here so the tool's surface is owned by the documents package, not the core
// composition that registers it.

import { TEMPLATE_IDS } from "./templates.ts";

export const DOCUMENT_RENDER_DESCRIPTION =
  "Render a Markdown document through a document-design template (report, essay, white paper, proposal, one-pager, letter, invoice, CV, slide deck) and write the PDF to a path inside the granted roots.";

export const DOCUMENT_RENDER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["template", "content", "title", "outputPath"],
  properties: {
    template: { enum: TEMPLATE_IDS, description: "The design-system template to render." },
    content: { type: "string", minLength: 1, maxLength: 200_000, description: "The document body as Markdown. Escaped and sanitised before rendering." },
    title: { type: "string", minLength: 1, maxLength: 300, description: "Document title (cover and running head)." },
    subtitle: { type: "string", maxLength: 500, description: "Optional subtitle." },
    outputPath: { type: "string", minLength: 1, maxLength: 4096, description: "Output PDF path, inside the granted roots." },
    meta: {
      type: "object",
      additionalProperties: true,
      description: "Template metadata (author, date, invoice lines, letter fields, …). Rendered escaped.",
    },
  },
} as const;

export interface DocumentRenderArgs {
  readonly template: string;
  readonly content: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly outputPath: string;
  readonly meta?: Record<string, unknown>;
}
