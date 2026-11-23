import { fileURLToPath } from "node:url";
import { markdownToHtml } from "../../packages/documents/src/markdown.ts";
import { contrast, NEUTRAL_KIT, NEUTRAL_REQUIREMENTS } from "../../packages/documents/src/tokens.ts";
import { exporterMain } from "./lib.mjs";

export function recordPureDocuments() {
  const markdown = [
    "# Heading\r\n\r\nFirst line\rSecond line",
    "- alpha\n- **beta**\n\n1. ordered\n2) text with *emphasis*",
    "## Small & useful\n\n> Literal <value>\n\n---",
    "[Documentation](https://example.invalid/guide) and [Chapter](#chapter_1)",
    "[A plain label](urn:example) and inline `<fixture>`",
    "```text\nA < B\n'b' uses quotes\n```",
    "```\nunclosed fence & input",
    "Two **strong** words, *italic*, and \"quotes\".",
  ].map(input => ({ input, html: markdownToHtml(input) }));
  const pairs = [
    ...NEUTRAL_REQUIREMENTS.map(pair => [
      NEUTRAL_KIT[pair.foreground as keyof typeof NEUTRAL_KIT] ?? pair.foreground,
      NEUTRAL_KIT[pair.background as keyof typeof NEUTRAL_KIT] ?? pair.background,
    ]),
    ["#fff", "#000"], ["#1111", "#808080FE"], ["aaFFcc", "#0fd"],
    ["#xyz", "#000"], ["#f1", "#000"],
  ];
  const ratios = pairs.map(([foreground, background]) => {
    try {
      return { foreground, background, ratio: contrast(foreground!, background!) };
    } catch {
      return { foreground, background, ratio: null };
    }
  });
  return { pure: { source: "packages/documents/src", markdown, ratios } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "documents", build: recordPureDocuments });
}
