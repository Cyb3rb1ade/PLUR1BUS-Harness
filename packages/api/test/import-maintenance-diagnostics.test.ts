import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeReport, failureReports } from "./fixtures/import-maintenance-diagnostics.mjs";

test("native failure diagnostics expose bounded counts and fixed labels only", () => {
  const privateValue = "PRIVATE-CONTENT-path-cookie-message";
  const result = summarizeReport({ errors: [{ reason: "source-unreadable", sourceRef: privateValue },
    ...Array.from({ length: 120 }, () => ({ reason: privateValue, message: privateValue }))],
    counts: { agentsRejected: 1, memoryCardsImported: privateValue, memoryCardsRejected: 2 },
    skills: [{ outcome: "failed", path: privateValue }], content: privateValue });
  assert.deepEqual(result, { status: "read", errors: 121, reasons: { "source-unreadable": 1, other: 99 },
    reasonsTruncated: true, agentsRejected: 1, memoryCardsImported: null, memoryCardsRejected: 2, skillsFailed: 1 });
  assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test("native report reading bounds files and handles absent or malformed reports", async () => {
  const home = await mkdtemp(join(tmpdir(), "p1b-native-report-"));
  try {
    const dir = join(home, "imports", "fixture", "skills");
    await mkdir(dir, { recursive: true });
    assert.deepEqual(await failureReports(home, "fixture"),
      { import: { status: "unavailable" }, skills: { status: "unavailable" } });
    await writeFile(join(home, "imports", "fixture", "report.json"), JSON.stringify({ errors: [] }));
    await writeFile(join(dir, "report.json"), "x".repeat(512 * 1024 + 1));
    const result = await failureReports(home, "fixture");
    assert.equal(result.import.status, "read");
    assert.deepEqual(result.skills, { status: "unavailable" });
    await writeFile(join(dir, "report.json"), "invalid PRIVATE-CONTENT");
    assert.deepEqual((await failureReports(home, "fixture")).skills, { status: "unavailable" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
