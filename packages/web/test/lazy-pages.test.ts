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
      const chunks: string[] = [];
      page.on("request", (r) => { if (/\/[\w-]+-[A-Z0-9]+\.js$/.test(r.url())) chunks.push(r.url()); });
      // slow the chunk down so the loading frame is really shown
      await page.route(/\/[\w-]+-[A-Z0-9]+\.js$/, async (route) => { await new Promise((r) => setTimeout(r, 300)); await route.continue(); });
      await page.getByRole("navigation").getByRole("link", { name: "Doctor" }).click();
      await page.getByRole("heading", { name: "Doctor", level: 1 }).waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === "H1" && document.activeElement.textContent === "Doctor");
      assert.ok(chunks.length >= 1, "the Doctor page came as a chunk");
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
      await page.unroute(chunk);
      await retry.click();
      await page.getByRole("button", { name: "Re-check" }).waitFor();
    });
  });
});
