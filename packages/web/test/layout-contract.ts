import assert from "node:assert/strict";
import type { Page } from "playwright";

export async function layout(page: Page, compact: boolean, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const targets: string[] = []; const smallText: string[] = [];
    const min = innerWidth / Number(document.documentElement.style.zoom || 1) < 1024 ? 44 : 24;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden" && !el.closest('[inert], .sr-only');
    };
    const zoom = Number(document.documentElement.style.zoom || 1);
    for (const el of Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role="tab"]'))) {
      if (!visible(el) || el.classList.contains("skip-link")) continue;
      // WCAG 2.5.5's Inline exception: a link embedded in prose cannot grow independently without overlapping text.
      // Standalone paragraph links and navigation links remain measured; this is semantic, not a page allowlist.
      const paragraph = el.closest("p");
      if (el.tagName === "A" && getComputedStyle(el).display === "inline" && paragraph && paragraph.textContent?.trim() !== el.textContent?.trim()) continue;
      const box = el.getBoundingClientRect();
      const cssSize = Math.min(box.width, box.height) / zoom;
      if (cssSize < min - 0.1) targets.push(`${el.tagName}.${el.className}: ${cssSize.toFixed(1)}px`);
    }
    const walker = document.createTreeWalker(document.querySelector("main")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.textContent?.trim() || !visible(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) smallText.push(`${el.tagName}: ${size}px`);
    }
    return { scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, targets, smallText, min };
  });
  assert.equal(result.min, compact ? 44 : 24);
  assert.equal(result.scroll, false, `${label}: document text overflows horizontally`);
  assert.deepEqual(result.targets, [], `${label}: undersized interactive targets`);
  assert.deepEqual(result.smallText, [], `${label}: text below 12 CSS px`);
}

