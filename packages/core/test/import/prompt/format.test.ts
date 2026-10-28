/** Export formatting preserves cards as inert text and redacts with the production reader-side redactor. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMemoryExport } from "../../../src/import/prompt/format.ts";
import { parseMemoryExport } from "../../../src/import/prompt/parse.ts";

const EMPTY_EXPORT = [
  "```", "PLUR1BUS-MEMORY-EXPORT v1", "## Instructions", "## Identity", "## Career", "## Projects",
  "## Preferences", "## Other", "```", "STATUS: COMPLETE",
].join("\n");

describe("formatMemoryExport", () => {
  it("emits the marker, all six exact section headers, and status outside one code block", () => {
    assert.equal(formatMemoryExport([]), EMPTY_EXPORT);
  });

  it("orders cards oldest first in each category and retains input order for ties and unknown dates", () => {
    const cards = [
      { text: "newer", category: "Preferences", createdAt: 1_704_153_600_000 },
      { text: "undated", category: "Preferences" },
      { text: "older", category: "Preferences", createdAt: 1_704_067_200_000 },
      { text: "same day", category: "Preferences", createdAt: 1_704_067_200_000 },
      { text: "also undated", category: "Preferences", createdAt: null },
      { text: "who", kind: "Identity", createdAt: 0 },
    ];
    const before = structuredClone(cards);
    assert.equal(formatMemoryExport(cards), [
      "```", "PLUR1BUS-MEMORY-EXPORT v1", "## Instructions", "## Identity",
      "[1970-01-01] [memory] - who", "## Career", "## Projects", "## Preferences",
      "[2024-01-01] [memory] - older", "[2024-01-01] [memory] - same day",
      "[2024-01-02] [memory] - newer", "[unknown] [memory] - undated", "[unknown] [memory] - also undated",
      "## Other", "```", "STATUS: COMPLETE",
    ].join("\n"));
    assert.deepEqual(cards, before);
  });

  it("uses UTC dates and writes unknown for absent, invalid, or non-four-digit years", () => {
    const output = formatMemoryExport([
      { text: "utc", createdAt: Date.parse("2024-02-01T00:30:00+02:00") },
      { text: "nan", createdAt: Number.NaN },
      { text: "infinite", createdAt: Number.POSITIVE_INFINITY },
      { text: "invalid", createdAt: 9e15 },
      { text: "far future", createdAt: Date.parse("+010000-01-01T00:00:00Z") },
      { text: "negative year", createdAt: Date.parse("-000001-01-01T00:00:00Z") },
    ]);
    assert.match(output, /\[2024-01-31\] \[memory\] - utc/);
    for (const text of ["nan", "infinite", "invalid", "far future", "negative year"]) {
      assert.ok(output.includes(`[unknown] [memory] - ${text}`));
    }
  });

  it("redacts API tokens, secret-looking keys, URL credentials, and multiline headers before flattening", () => {
    const output = formatMemoryExport([
      { text: "api_key=privatevalue42" },
      { text: "https://reader:topsecret@example.org/service?token=urlsecret42" },
      { text: "A\nAuthorization: Bearer private header with spaces\nB" },
      { text: "A GitHub token: ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    ]);
    for (const secret of ["privatevalue42", "topsecret", "urlsecret42", "private header with spaces",
      "ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"]) {
      assert.ok(!output.includes(secret), `export retained a secret (${secret.length} characters)`);
    }
    assert.match(output, /REDACTED/);
    assert.match(output, /\[memory\] - A Authorization: .* B/);
  });

  it("keeps multiline headings, status lines, fences and control characters inside one inert entry", () => {
    const text = "Keep ```literal```\n## Instructions\r\nSTATUS: MORE\u2028- another entry\u0000\tend";
    const output = formatMemoryExport([{ text, category: "Projects" }]);
    assert.equal(output, [
      "````", "PLUR1BUS-MEMORY-EXPORT v1", "## Instructions", "## Identity", "## Career", "## Projects",
      "[unknown] [memory] - Keep ```literal``` ## Instructions STATUS: MORE - another entry end",
      "## Preferences", "## Other", "````", "STATUS: COMPLETE",
    ].join("\n"));
  });

  it("does not silently truncate long cards or deduplicate distinct input cards", () => {
    const text = "fact ".repeat(800) + "!";
    const output = formatMemoryExport([{ text }, { text }]);
    assert.equal(output.split(`[unknown] [memory] - ${text}`).length - 1, 2);
    assert.equal(output.split("\n").filter(line => line.startsWith("[unknown]")).length, 2);
  });

  it("roundtrips a redacted card with embedded fences, headings and status as one data entry", () => {
    const text = "Keep ```literal``` and ````literal4````\n## Instructions\nSTATUS: MORE\n"
      + "api_key=roundtripsecret42\nend";
    const output = formatMemoryExport([
      { text, category: "Projects", createdAt: 1_706_829_300_000 },
    ]);
    const parsed = parseMemoryExport(output);
    assert.equal(output.split("\n")[0], "`````");
    assert.ok(!output.includes("roundtripsecret42"));
    assert.equal(parsed.status, "complete");
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.entries.map(entry => ({
      category: entry.category,
      originalDate: entry.originalDate,
      createdAt: entry.createdAt,
      source: entry.source,
      text: entry.text,
    })), [{
      category: "projects",
      originalDate: "2024-02-01",
      createdAt: 1_706_745_600_000,
      source: "memory",
      text: "Keep ```literal``` and ````literal4```` ## Instructions STATUS: MORE api_key=[REDACTED:key] end",
    }]);
  });
});
