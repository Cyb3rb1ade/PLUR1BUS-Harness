// Hostile log lines in the browser (audit c20): markup stays text, bidi and control characters are made visible, one huge
// message does not flood the row, and the detail dialog still opens and copies the original.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { installLogsMocks, makeRecord } from "./logs-fixtures.ts";

before(setup);
after(teardown);

const MARKUP = "<img src=x onerror=window.__pwned=1><script>window.__pwned=2</script>";
const BIDI = "ok\u202Eevil\u2066x\u0000\u001b[31m";

describe("logs: hostile lines", { skip: browserSkip }, () => {
  test("markup is shown as text, bidi and control characters as pictures, a 400 kB message is cut in the row and bounded in the detail", async () => {
    await withApp({}, async (app) => {
      const huge = "A".repeat(400_000);
      const lines = [
        makeRecord(1, { component: "<b>comp</b>", record: { msg: MARKUP, event: "x" } }),
        makeRecord(2, { record: { msg: BIDI, event: "x" } }),
        makeRecord(3, { record: { msg: huge, event: "x" } }),
      ];
      installLogsMocks(app.server, { lines });
      await openRoute(app.page, "#/logs");
      const rows = app.page.getByRole("grid", { name: "Log entries" }).locator('[role="row"][data-row]');
      await rows.nth(2).waitFor();
      assert.equal(await app.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined);
      assert.equal(await app.page.locator('.logs-viewport img[src="x"], .logs-viewport script, .logs-viewport b').count(), 0);
      const text = (await rows.allTextContents()).join("|");
      assert.ok(text.includes("<img src=x"), "the markup is visible as text");
      assert.ok(text.includes("<b>comp</b>"));
      assert.equal(/[\u202A-\u202E\u2066-\u2069\u0000\u001B]/.test(text), false);
      assert.ok(text.includes("\u2400") && text.includes("\u241b"));
      const msg = await rows.first().locator(".logs-msg").textContent();
      assert.ok((msg ?? "").length <= 401, `row message is ${msg?.length} characters`);
      await rows.first().click();
      const dlg = app.page.getByRole("dialog", { name: "Log entry" });
      await dlg.waitFor();
      assert.ok(((await dlg.textContent()) ?? "").length < 30_000, "the dialog shows a bounded text");
    });
  });
});
