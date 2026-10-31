import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMemoryExport } from "../../../src/import/prompt/parse.ts";

describe("parseMemoryExport", () => {
  it("parses full export with all six categories and metadata", () => {
    const text = `
PLUR1BUS-MEMORY-EXPORT v1
## Instructions
[2024-01-01] [memory] - Always respond concisely and never use marketing jargon.
## Identity
[2024-02-15] [memory] - Alex, 34, software engineer living in Berlin.
## Career
[2023-05-10] [memory] - Senior Staff Engineer at Acme Corp, leading cloud infrastructure.
## Projects
[2024-03-01] [chat] - PLUR1BUS: Local AI harness, designed modular engine and RPC surface.
## Preferences
[2024-04-10] [memory] - Prefers TypeScript and Rust over Python for systems programming.
## Other
[unknown] [memory] - Cat named Pixel.
STATUS: COMPLETE
`;
    const res = parseMemoryExport(text);
    assert.equal(res.status, "complete");
    assert.equal(res.entries.length, 6);
    assert.equal(res.entries[0]!.category, "Instructions");
    assert.equal(res.entries[0]!.text, "Always respond concisely and never use marketing jargon.");
    assert.equal(res.entries[0]!.sourceType, "memory");
    assert.equal(res.entries[0]!.recordedAt, "2024-01-01T00:00:00.000Z");

    assert.equal(res.entries[3]!.category, "Projects");
    assert.equal(res.entries[3]!.sourceType, "chat");

    assert.equal(res.entries[5]!.category, "Other");
    assert.equal(res.entries[5]!.recordedAt, undefined);
  });

  it("handles export without PLUR1BUS header (Claude style)", () => {
    const text = `
Here are the stored memories:
# Instructions
- [memory] Be direct.
# Identity
- Name: Chris
STATUS: COMPLETE
`;
    const res = parseMemoryExport(text);
    assert.equal(res.status, "complete");
    assert.equal(res.entries.length, 2);
    assert.equal(res.entries[0]!.category, "Instructions");
    assert.equal(res.entries[0]!.text, "Be direct.");
    assert.equal(res.entries[1]!.category, "Identity");
    assert.equal(res.entries[1]!.text, "Name: Chris");
  });

  it("handles export inside code fences", () => {
    const text = `
\`\`\`markdown
PLUR1BUS-MEMORY-EXPORT v1
## Preferences
[2024-01-01] [memory] - Dark mode always.
\`\`\`
STATUS: COMPLETE
`;
    const res = parseMemoryExport(text);
    assert.equal(res.status, "complete");
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0]!.text, "Dark mode always.");
  });

  it("handles German headings and date variants", () => {
    const text = `
## Anweisungen
[2024-06-15] [memory] - Immer sachlich bleiben.
## Identität
[2024-06] [memory] - Wohnt in Hamburg.
## Beruf
[2020] [memory] - Gründer bei TechGmbH.
## Projekte
[unbekannt] [chat] – Projekt X: Mobile App.
## Vorlieben
- Kein Koffein nach 14 Uhr.
## Sonstiges
- Verschiedenes.
`;
    const res = parseMemoryExport(text);
    assert.equal(res.entries.length, 6);
    assert.equal(res.entries[0]!.category, "Instructions");
    assert.equal(res.entries[1]!.category, "Identity");
    assert.equal(res.entries[1]!.recordedAt, "2024-06-01T00:00:00.000Z");
    assert.equal(res.entries[2]!.category, "Career");
    assert.equal(res.entries[2]!.recordedAt, "2020-01-01T00:00:00.000Z");
    assert.equal(res.entries[3]!.category, "Projects");
    assert.equal(res.entries[3]!.recordedAt, undefined);
    assert.equal(res.entries[4]!.category, "Preferences");
    assert.equal(res.entries[4]!.text, "Kein Koffein nach 14 Uhr.");
    assert.equal(res.entries[5]!.category, "Other");
  });

  it("handles continuation lines", () => {
    const text = `
## Projects
[2024-01-01] [memory] - Main project overview.
  Additional details about architecture.
  Third line with more info.
[2024-01-02] [memory] - Next project.
`;
    const res = parseMemoryExport(text);
    assert.equal(res.entries.length, 2);
    assert.equal(
      res.entries[0]!.text,
      "Main project overview.\nAdditional details about architecture.\nThird line with more info.",
    );
    assert.equal(res.entries[1]!.text, "Next project.");
  });

  it("detects STATUS: MORE", () => {
    const text = `
## Instructions
[2024-01-01] [memory] - Rule 1.
STATUS: MORE
`;
    const res = parseMemoryExport(text);
    assert.equal(res.status, "more");
    assert.equal(res.entries.length, 1);
  });

  it("truncates entries exceeding 4,000 characters and sets warning", () => {
    const longString = "A".repeat(5000);
    const text = `
## Identity
[2024-01-01] [memory] - ${longString}
`;
    const res = parseMemoryExport(text);
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0]!.text.length, 4000);
    assert.ok(res.entries[0]!.warnings.includes("overlong-entry"));
  });

  it("redacts secrets and tags entry with secret-redacted", () => {
    const text = `
## Identity
[2024-01-01] [memory] - My key is sk-ant-api03-1234567890abcdef1234567890abcdef1234567890abcdef and password is topsecret.
`;
    const res = parseMemoryExport(text);
    assert.equal(res.entries.length, 1);
    assert.ok(res.entries[0]!.warnings.includes("secret-redacted"));
    assert.ok(!res.entries[0]!.text.includes("sk-ant-api03-"));
  });

  it("returns status unrecognized for empty or garbage text", () => {
    const res1 = parseMemoryExport("");
    assert.equal(res1.status, "unrecognized");
    assert.equal(res1.entries.length, 0);

    const res2 = parseMemoryExport("Random non-memory chat without any categories or structure\nJust plain dialogue");
    assert.equal(res2.status, "unrecognized");
    assert.equal(res2.entries.length, 0);
  });

  it("processes 512 KiB hostile text within time bound (< 500 ms)", () => {
    const lines: string[] = ["## Other\n"];
    for (let i = 0; i < 4000; i++) {
      lines.push(`[2024-01-01] [memory] - Item ${i} with repetitive content padding ${"x".repeat(100)}\n`);
    }
    const bigText = lines.join("");
    const start = Date.now();
    const res = parseMemoryExport(bigText);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `Elapsed ${elapsed}ms exceeded 500ms`);
    assert.ok(res.entries.length > 0);
  });
});
