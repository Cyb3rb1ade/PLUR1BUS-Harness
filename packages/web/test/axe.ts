import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Page } from "playwright";

const axeSource = readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

export type Violation = { id: string; impact: string | null; help: string; nodes: { target: unknown[]; html: string }[] };

/** Waits for what a fixed pause only hopes for: web fonts loaded, every finite CSS transition/animation finished (axe reads
 *  computed colours, and under load a theme or locale switch is still mid-transition after any fixed time), and two frames
 *  painted. Infinite animations (spinners) are not waited for. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let round = 0; round < 10; round++) {
      const running = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
      if (running.length === 0) break;
      await Promise.allSettled(running.map((a) => a.finished));
    }
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
}

/** WCAG 2.0/2.1/2.2 A and AA plus axe's best-practice rules (same rule set as a11y.test.ts). */
export async function axeViolations(page: Page): Promise<Violation[]> {
  await page.locator(".wordmark-morph[data-collapsed=false]").waitFor({ state: "attached" }).catch(() => {});
  await page.waitForTimeout(250);
  await settled(page);
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
