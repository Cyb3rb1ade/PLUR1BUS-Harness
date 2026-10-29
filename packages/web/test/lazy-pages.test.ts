// Pages are separate chunks loaded on first use (src/pages/lazy.ts): the loading frame, a failed load with "Try again", and
// focus on the heading after a navigation to a page that has to be fetched first. Runs under the strict CSP of the mock server.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, setup, signIn, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("lazy pages", opts, () => {
  test("a navigation to a page that is not loaded yet moves focus to the new page's heading; no CSP violation", async () => {
    await withApp({}, async ({ page, problems }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      // The chunks the page has fetched so far, from the page's own resource timing: a listener for requests only sees what
      // comes after it was attached, and a page frame is drawn (heading and all) before the import behind it has started.
      const chunks = (): Promise<string[]> => page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/[\w-]+-[A-Z0-9]+\.js$/.test(n)));
      // The Chat page is a chunk with chunks behind it: what it still fetches must not count as the Doctor page's.
      let before = await chunks();
      for (let i = 0; i < 40; i++) { // bounded: 10 s
        await page.waitForTimeout(250);
        const now = await chunks();
        if (now.length === before.length) break;
        before = now;
      }
      // slow the chunk down so the loading frame is really shown
      await page.route(/\/[\w-]+-[A-Z0-9]+\.js$/, async (route) => { await new Promise((r) => setTimeout(r, 300)); await route.continue(); });
      await page.getByRole("navigation").getByRole("link", { name: "Doctor" }).click();
      await page.getByRole("heading", { name: "Doctor", level: 1 }).waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === "H1" && document.activeElement.textContent === "Doctor");
      await page.getByRole("button", { name: "Re-check" }).waitFor(); // the page itself has arrived and replaced the frame
      await page.waitForFunction(() => document.activeElement?.tagName === "H1" && document.activeElement.textContent === "Doctor");
      const after = await chunks();
      assert.ok(after.some((c) => !before.includes(c)), `the Doctor page came as a chunk (fetched before the click: ${before.join(" ")}; after: ${after.join(" ")})`);
      assert.deepEqual(problems, []);
    });
  });

  test("a failed chunk shows the error state; Try again loads the page", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      const chunk = /\/[\w-]+-[A-Z0-9]+\.js$/;
      await page.route(chunk, (route) => route.abort());
      await page.getByRole("navigation").getByRole("link", { name: "Doctor" }).click();
      await page.getByRole("heading", { name: "Doctor", level: 1 }).waitFor();
      const retry = page.getByRole("button", { name: "Try again" });
      await retry.waitFor();
      assert.ok(await page.getByText("The part of the app for this page did not arrive").isVisible(), "says that the page could not be loaded, not a generic failure");
      await page.unroute(chunk);
      await retry.click();
      await page.getByRole("button", { name: "Re-check" }).waitFor();
    });
  });
});
