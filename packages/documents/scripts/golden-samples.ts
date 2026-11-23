import type { TemplateId } from "../src/index.ts";

export const SAMPLES: Record<TemplateId, { content: string; meta: Record<string, unknown> }> = {
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
