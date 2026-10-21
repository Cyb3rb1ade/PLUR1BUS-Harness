// Focus is part of the draw that shows a view, not a later effect. A view that is visible and operable before it takes the focus
// lets a key or click that arrives in between be overridden by the late focus() (same class as the setup wizard, PR #622).
// Each test records, in a MutationObserver callback (a microtask right after the draw that inserts the element), whether the
// element that should hold the focus already has it. A passive effect runs after the paint and fails these.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { withChat, type FakeChat } from "./chat-fixtures.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import type { MockRpc } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

type Seen = { key: string; focused: boolean };

describe("focus lands in the draw that shows the view", opts, () => {
  test("sign-in: the token field is focused when it first appears", async () => {
    await withApp({}, async ({ page }) => {
      await page.addInitScript(() => {
        const seen: Seen[] = [];
        (window as unknown as { __seen: Seen[] }).__seen = seen;
        const look = (): void => {
          const el = document.getElementById("login-token");
          if (el && seen.length === 0) seen.push({ key: "login-token", focused: document.activeElement === el });
        };
        new MutationObserver(look).observe(document, { childList: true, subtree: true });
      });
      await page.reload();
      await page.getByLabel("Owner token", { exact: true }).waitFor();
      const seen = await page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
      assert.deepEqual(seen, [{ key: "login-token", focused: true }]);
    });
  });

  test("chat: the composer of a session that finished loading is focused when it appears", async () => {
    const two = (c: FakeChat): void => {
      c.seed({ id: "ses_1", title: "Hello world", messages: [["user", "Earlier question"], ["assistant", "Earlier answer"]] });
      c.seed({ id: "ses_2", title: "Second chat", agentId: "mara", messages: [["user", "Other question"], ["assistant", "Other answer"]] });
    };
    await withChat({ route: "#/chat/ses_1", seed: two }, async ({ page }) => {
      await page.getByRole("textbox", { name: "Message to bernd" }).waitFor();
      await page.evaluate(() => {
        const seen: Seen[] = [];
        (window as unknown as { __seen: Seen[] }).__seen = seen;
        let last: Element | null = null;
        new MutationObserver(() => {
          const el = document.querySelector("textarea");
          if (el && el !== last) { last = el; seen.push({ key: "composer", focused: document.activeElement === el }); }
        }).observe(document.body, { childList: true, subtree: true });
      });
      await page.evaluate(() => { location.hash = "#/chat/ses_2"; });
      await page.getByRole("textbox", { name: "Message to mara" }).waitFor();
      const seen = await page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
      assert.deepEqual(seen, [{ key: "composer", focused: true }]);
    });
  });

  test("usage: the limit dialog's review step has its heading focused when it appears", async () => {
    await withApp({}, async (app) => {
      seedBudget(app.server.rpc);
      await openRoute(app.page, "#/usage");
      await app.page.getByRole("button", { name: "Set limit" }).first().click();
      const dlg = app.page.getByRole("dialog", { name: "Set limit" });
      await dlg.getByLabel("Hard limit").fill("200");
      await app.page.evaluate(() => {
        const seen: Seen[] = [];
        (window as unknown as { __seen: Seen[] }).__seen = seen;
        new MutationObserver(() => {
          const h = document.querySelector("dialog[open] .dialog-head h2");
          const key = h?.textContent ?? "";
          if (h && key !== "" && seen[seen.length - 1]?.key !== key) seen.push({ key, focused: document.activeElement === h });
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      await dlg.getByRole("button", { name: "Review" }).click();
      await app.page.getByRole("dialog", { name: "Confirm limit" }).waitFor();
      const seen = await app.page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
      assert.deepEqual(seen.map((s) => s.key), ["Confirm limit"]);
      assert.deepEqual(seen.filter((s) => !s.focused).map((s) => s.key), []);
    });
  });
});

function seedBudget(rpc: MockRpc): void {
  const period = { period: "day", key: "2026-10-07", start: "2026-10-07T00:00:00+02:00", end: "2026-10-08T00:00:00+02:00", total: { events: 4, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 10 }, agents: [] };
  rpc.handle("budget.status", () => ({ timeZone: "Europe/Berlin", now: "2026-10-07T09:00:00+02:00", periods: [period], limits: [] }), { write: false });
}
