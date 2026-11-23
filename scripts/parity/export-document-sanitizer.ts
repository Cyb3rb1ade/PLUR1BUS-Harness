import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildDocumentHtml } from "../../packages/documents/src/templates.ts";
import { markdownToHtml } from "../../packages/documents/src/markdown.ts";
import { sanitizeHtml } from "../../packages/documents/src/sanitize.ts";
import { NEUTRAL_KIT } from "../../packages/documents/src/tokens.ts";
import { exporterMain } from "./lib.mjs";

export function recordDocumentSanitizer() {
  const templates = ["report", "letter", "invoice", "cv", "slides"] as const;
  const samples = [
    "The manual labels this <entry style=plain>.",
    "The catalogue shows <entry onlabel=visible>.",
    "The example reads <entry src=about:blank>.",
    "The note uses <entry href=data:,catalogue>.",
    "Example notation <entry style='ordinary value'>.",
    "Envelope <entry label=approved>.",
    "Draft <entry title='review copy'>.",
    "Literal text describes A < B & C > D.",
    "The note quotes \"edition\" and 'proof'.",
    "An example reads <entry src=cover.png>.",
  ];
  const cases = templates.flatMap(template => samples.map(markdown => {
    const escaped = markdownToHtml(markdown);
    const sanitized = sanitizeHtml(escaped);
    const options = { title: "Fixture", subtitle: "", meta: {}, kit: NEUTRAL_KIT };
    return {
      input: { template, markdown },
      escaped,
      sanitized,
      typescriptSha256: createHash("sha256")
        .update(buildDocumentHtml(template, { ...options, bodyHtml: sanitized })).digest("hex"),
      ...(escaped === sanitized ? {} : { expectedDivergence: "P4D-252" }),
    };
  }));
  return { sanitizer: { source: "packages/documents/src/sanitize.ts", cases } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "documents", build: recordDocumentSanitizer });
}
