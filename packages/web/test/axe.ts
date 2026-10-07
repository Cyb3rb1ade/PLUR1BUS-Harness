import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Page } from "playwright";

const axeSource = readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

export type Violation = { id: string; impact: string | null; help: string; nodes: { target: unknown[]; html: string }[] };

/** WCAG 2.0/2.1/2.2 A and AA plus axe's best-practice rules (same rule set as a11y.test.ts). */
export async function axeViolations(page: Page): Promise<Violation[]> {
  await page.evaluate(await axeSource);
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Violation[] }> } }).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    });
    return r.violations;
  });
}

export async function expectAxeClean(page: Page, label: string): Promise<void> {
  const v = await axeViolations(page);
  const text = v.map((x) => `${x.id} (${x.impact}): ${x.help}\n${x.nodes.map((n) => `  ${JSON.stringify(n.target)} ${n.html.slice(0, 120)}`).join("\n")}`).join("\n");
  assert.equal(v.length, 0, `${label}\n${text}`);
}
