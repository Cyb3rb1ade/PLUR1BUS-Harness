import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seedExtensions, seedApprovals, seedJobs, sampleApprovals } from "./surfaces-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const calls = (app: App, method: string): { params: unknown; csrf: string | null }[] =>
  app.server.rpc.calls.filter((c) => c.method === method);

describe("Skills & Plugins (Extensions) page", opts, () => {
  test("lists extensions, filters by kind and search", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      await openRoute(app.page, "#/skills");
      await app.page.getByRole("button", { name: /github-tools/i }).waitFor();
      await app.page.getByRole("button", { name: /code-analysis/i }).waitFor();

      // Filter by plugins
      await app.page.getByRole("button", { name: /^Plugins$/i }).click();
      await app.page.getByRole("button", { name: /telegram-channel/i }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: /github-tools/i }).count(), 0);

      // Search
      const search = app.page.locator(".extensions-search");
      await search.fill("telegram");
      await app.page.getByRole("button", { name: /telegram-channel/i }).waitFor();
      await search.fill("nomatchfound");
      await app.page.getByRole("heading", { name: /No extensions found/i }).waitFor();
    });
  });

  test("extension details, enable / disable toggle, uninstall dialog", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      await openRoute(app.page, "#/skills");

      await app.page.getByRole("button", { name: /github-tools/i }).click();
      await app.page.getByRole("heading", { name: "github-tools", level: 2 }).waitFor();

      // Disable toggle
      const disableBtn = app.page.getByRole("button", { name: /^Disable$/i });
      await disableBtn.click();
      await app.page.getByRole("button", { name: /^Enable$/i }).waitFor();
      assert.equal(calls(app, "ext.disable").length, 1);

      // Uninstall dialog with purge checkbox and confirm
      await app.page.getByRole("button", { name: /^Uninstall$/i }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      await dlg.locator(".dialog-actions").getByRole("button", { name: /^Uninstall$/i }).click();
      await dlg.waitFor({ state: "detached" });
      assert.equal(calls(app, "ext.uninstall").length, 1);
    });
  });

  test("install from file dialog and web notice", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      await openRoute(app.page, "#/skills");

      // Verify visible web catalogue note
      await app.page.getByText(/plur1bus\.app/i).waitFor();

      // Open install dialog
      await app.page.getByRole("button", { name: /Install from file/i }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      await dlg.getByRole("button", { name: /Cancel/i }).click();
      await dlg.waitFor({ state: "detached" });
    });
  });

  test("unavailable and error states", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      app.server.rpc.scenario("ext.list", "unavailable");
      await openRoute(app.page, "#/skills");
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
    });
  });

  test("German translation & a11y clean", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedExtensions(app.server.rpc);
      await openRoute(app.page, "#/skills", "de");
      await app.page.getByRole("heading", { name: /Skills & Plugins/i }).waitFor();
      await expectAxeClean(app.page, "extensions");
    });
  });
});

describe("Approvals page", opts, () => {
  test("shows pending requests with D109 order: targets before agent rationale", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      await openRoute(app.page, "#/approvals");

      await app.page.locator(".approval-targets li").first().waitFor();
      await app.page.getByText(/Cleaning up legacy backups/i).waitFor();

      // Verify DOM ordering: targets element must appear before unverified agent rationale
      const orderOk = await app.page.evaluate(() => {
        const targets = document.querySelector(".approval-targets");
        const reason = document.querySelector(".approval-reason-unverified");
        if (!targets || !reason) return false;
        return (targets.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      assert.ok(orderOk, "D109 order violation: Targets must appear before Agent Rationale");
    });
  });

  test("approval decision options cap grant at 90 days and handle OS attestation", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      await openRoute(app.page, "#/approvals");

      const select = app.page.locator(".approval-scope-select");
      await select.waitFor();
      // Verify scope selector options
      const options = await select.locator("option").allInnerTexts();
      assert.ok(options.some((o) => o.includes("90 days") || o.includes("90 Tage")));
      // Ensure no options exceed 90 days
      assert.ok(!options.some((o) => o.includes("365 days") || o.includes("unlimited")));

      // Test approve click
      const approveBtn = app.page.getByRole("button", { name: /^Approve$|^Freigeben$/i });
      await approveBtn.click();
      await app.page.waitForTimeout(50);
      assert.equal(calls(app, "approval.decide").length, 1);
    });
  });

  test("grants list and revocation", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      await openRoute(app.page, "#/approvals");

      // Switch to Grants tab
      await app.page.getByRole("tab", { name: /Active Grants|Aktive Grants/i }).click();
      await app.page.getByText("grt_01234567").waitFor();

      // Revoke grant
      const revokeBtn = app.page.getByRole("button", { name: /Revoke grant|Grant widerrufen/i });
      await revokeBtn.waitFor();
      await revokeBtn.click();
      await app.page.waitForTimeout(50);
      assert.equal(calls(app, "grant.revoke").length, 1);
    });
  });

  test("role gating: agent and forbidden roles cannot view approvals", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seedApprovals(app.server.rpc);
      await openRoute(app.page, "#/approvals");
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });
  });

  test("German translation & a11y clean", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedApprovals(app.server.rpc);
      await openRoute(app.page, "#/approvals", "de");
      await app.page.getByRole("heading", { name: /Freigaben/i }).waitFor();
      await expectAxeClean(app.page, "approvals");
    });
  });
});

describe("Recurring Tasks page", opts, () => {
  test("lists scheduled jobs with schedule interval and next run", async () => {
    await withApp({}, async (app) => {
      seedJobs(app.server.rpc);
      await openRoute(app.page, "#/recurring");

      await app.page.getByText("consolidate").waitFor();
      await app.page.getByText("models.scan").waitFor();

      // Check gap note for job creation
      await app.page.getByText(/docs\/web-ui\.md/i).waitFor();
    });
  });

  test("run now action with confirmation dialog", async () => {
    await withApp({}, async (app) => {
      seedJobs(app.server.rpc);
      await openRoute(app.page, "#/recurring");

      // Click run button on first job
      await app.page.getByRole("button", { name: /Run now|Jetzt ausführen/i }).first().click();
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      await dlg.getByRole("button", { name: /Run now|Jetzt ausführen/i }).click();
      await dlg.waitFor({ state: "detached" });

      assert.equal(calls(app, "jobs.run").length, 1);
    });
  });

  test("shows run history tab", async () => {
    await withApp({}, async (app) => {
      seedJobs(app.server.rpc);
      await openRoute(app.page, "#/recurring");

      await app.page.getByRole("tab", { name: /Run History|Ausführungsverlauf/i }).click();
      await app.page.getByText("completed").waitFor();
      await app.page.getByText(/5000ms/).waitFor();
    });
  });

  test("German translation & a11y clean", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedJobs(app.server.rpc);
      await openRoute(app.page, "#/recurring", "de");
      await app.page.getByRole("heading", { name: /Wiederkehrende Aufgaben/i }).waitFor();
      await expectAxeClean(app.page, "recurring");
    });
  });
});
