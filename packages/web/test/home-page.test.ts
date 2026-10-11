import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, signIn, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("Home page & V2LogoMorph", opts, () => {
  test("clicking wordmark morphs back to PLUR1BUS and opens Home page (#/home)", async () => {
    await withApp({}, async ({ page, server }) => {
      server.rpc.handle("core.status", () => ({
        process: { state: "running" },
        engine: { ready: true, degraded: null },
      }), { write: false });

      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();

      // Wordmark is visible in the sidebar
      const wordmark = page.locator(".wordmark-morph");
      await wordmark.waitFor();

      // Click wordmark
      await wordmark.click();

      // Should navigate to Home page
      await page.waitForFunction(() => location.hash === "#/home");
      await page.getByRole("heading", { name: "Welcome to PLUR1BUS", level: 1 }).waitFor();

      // Wordmark displays PLUR1BUS
      const text = await wordmark.innerText();
      assert.ok(text.replace(/\s+/g, "").includes("PLUR1BUS"));
    });
  });

  test("empty link placeholders (contact, donate) are hidden, known links present", async () => {
    await withApp({}, async ({ page, server }) => {
      server.rpc.handle("core.status", () => ({
        process: { state: "running" },
        engine: { ready: true, degraded: null },
      }), { write: false });

      await openRoute(page, "#/home");
      await page.getByRole("heading", { name: "Welcome to PLUR1BUS", level: 1 }).waitFor();

      // Check external links
      const links = page.locator(".home-link");
      const count = await links.count();
      assert.ok(count >= 4);

      // Contact and Donate should not appear
      assert.equal(await page.getByText("Contact", { exact: true }).count(), 0);
      assert.equal(await page.getByText("Donate / Sponsor", { exact: true }).count(), 0);

      // Known links appear
      await page.getByText("User Handbook").waitFor();
      await page.getByText("GitHub: PLUR1BUS-Harness").waitFor();

      // External link opens in system browser with rel="noopener noreferrer"
      const githubLink = page.locator('a[href="https://github.com/Cyb3rb1ade/PLUR1BUS-Harness"]');
      assert.equal(await githubLink.getAttribute("target"), "_blank");
      assert.equal(await githubLink.getAttribute("rel"), "noopener noreferrer");
    });
  });

  test("shows version and core status facts compactly", async () => {
    await withApp({}, async ({ page, server }) => {
      server.rpc.handle("core.status", () => ({
        process: { state: "running" },
        engine: { ready: true, degraded: null, models: { embedder: { state: "ready" }, reranker: { state: "ready" } } },
      }), { write: false });

      await openRoute(page, "#/home");
      await page.getByRole("heading", { name: "Welcome to PLUR1BUS", level: 1 }).waitFor();

      await page.getByText("Core Status").waitFor();
      await page.getByText("Connected").waitFor();
      await page.getByText("Engine Ready").waitFor();
    });
  });
});
