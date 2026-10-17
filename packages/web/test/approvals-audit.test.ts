// Audit of #/approvals (agent c17): double submits, focus and announcements, localized errors instead of server text, credentials in
// the details. Everything runs against the typed mock; the real transport is not wired yet.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { sampleApprovals, sampleGrants, seedApprovals, seedJobs } from "./surfaces-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const calls = (app: App, method: string): { params: unknown }[] => app.server.rpc.calls.filter((c) => c.method === method);
function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  return { held, release };
}
/** Resolves once the n-th call of `method` has reached the mock. */
function waitFor(app: App, method: string, n: number): Promise<void> {
  return new Promise((resolve) => {
    const poll = (): void => { if (calls(app, method).length >= n) resolve(); else setTimeout(poll, 5); };
    poll();
  });
}
const approveBtn = (page: Page) => page.getByRole("button", { name: /^Approve$|^Freigeben$/ });

/** Clicks the buttons with these names one after the other inside ONE task, before the page can re-render. */
async function clickInOneTask(page: Page, names: RegExp[]): Promise<void> {
  await page.evaluate((sources) => {
    for (const src of sources) {
      const re = new RegExp(src);
      const b = Array.from(document.querySelectorAll("button")).find((x) => re.test((x.textContent ?? "").trim()));
      (b as HTMLButtonElement).click();
    }
  }, names.map((r) => r.source));
}

const secret = (): string => ["sk", "z".repeat(26)].join("-");

describe("Approvals: no double decisions", opts, () => {
  test("two Approve clicks in one task send one approval.decide", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      const g = gate();
      app.server.rpc.handle("approval.decide", async () => { await g.held; return { approval: { ...sampleApprovals[0]!, status: "approved" } }; });
      await openRoute(app.page, "#/approvals");
      await approveBtn(app.page).waitFor();
      await clickInOneTask(app.page, [/^Approve$/, /^Approve$/]);
      await waitFor(app, "approval.decide", 1);
      g.release();
      await app.page.waitForTimeout(150);
      assert.equal(calls(app, "approval.decide").length, 1);
    });
  });

  test("a denial carries neither a grant scope nor delegation; an approval carries the chosen ones", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      await openRoute(app.page, "#/approvals");
      await app.page.getByRole("button", { name: "Deny" }).click();
      await waitFor(app, "approval.decide", 1);
      assert.deepEqual(calls(app, "approval.decide")[0]!.params, { id: sampleApprovals[0]!.id, decision: "deny" });
    });
  });

  test("Approve and then Deny in one task send one decision", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      const g = gate();
      app.server.rpc.handle("approval.decide", async () => { await g.held; return { approval: { ...sampleApprovals[0]!, status: "approved" } }; });
      await openRoute(app.page, "#/approvals");
      await approveBtn(app.page).waitFor();
      await clickInOneTask(app.page, [/^Approve$/, /^Deny$/]);
      await waitFor(app, "approval.decide", 1);
      g.release();
      await app.page.waitForTimeout(150);
      assert.equal(calls(app, "approval.decide").length, 1);
    });
  });

  test("once a decision went through, the card cannot decide again while the list is still reloading", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      const g = gate();
      let lists = 0;
      app.server.rpc.handle("approval.list", async () => { lists++; if (lists > 1) await g.held; return { approvals: sampleApprovals }; }, { write: false });
      await openRoute(app.page, "#/approvals");
      await approveBtn(app.page).click();
      await waitFor(app, "approval.list", 2); // the reload is on its way and held; the old card is still on screen
      await clickInOneTask(app.page, [/^Approve$/, /^Deny$/]);
      await app.page.waitForTimeout(100);
      g.release();
      assert.equal(calls(app, "approval.decide").length, 1);
    });
  });

  test("two Revoke clicks in one task send one grant.revoke", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      const g = gate();
      app.server.rpc.handle("grant.revoke", async () => { await g.held; return { ...sampleGrants[0]!, state: "revoked" }; });
      await openRoute(app.page, "#/approvals");
      await app.page.getByRole("tab", { name: /Active Grants/ }).click();
      await app.page.getByRole("button", { name: "Revoke grant" }).waitFor();
      await clickInOneTask(app.page, [/^Revoke grant$/, /^Revoke grant$/]);
      await waitFor(app, "grant.revoke", 1);
      g.release();
      await app.page.waitForTimeout(150);
      assert.equal(calls(app, "grant.revoke").length, 1);
    });
  });
});

describe("Approvals: focus and announcements", opts, () => {
  test("the clicked button keeps the focus while the decision is in flight", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      const g = gate();
      app.server.rpc.handle("approval.decide", async () => { await g.held; return { approval: { ...sampleApprovals[0]!, status: "approved" } }; });
      await openRoute(app.page, "#/approvals");
      await approveBtn(app.page).focus();
      await app.page.keyboard.press("Enter");
      await waitFor(app, "approval.decide", 1);
      await app.page.waitForTimeout(50);
      const label = await app.page.evaluate(() => document.activeElement?.textContent ?? "");
      assert.equal(label, "Approve", "a disabled button would drop the focus to the page body");
      g.release();
    });
  });

  test("after a decision the focus stays inside the page and the result is announced", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      let decided = false;
      app.server.rpc.handle("approval.decide", () => { decided = true; return { approval: { ...sampleApprovals[0]!, status: "approved" } }; });
      app.server.rpc.handle("approval.list", () => ({ approvals: decided ? [] : sampleApprovals }), { write: false });
      await openRoute(app.page, "#/approvals");
      await approveBtn(app.page).focus();
      // Capture the first DOM commit containing the result, before deferred effects can repair focus.
      await app.page.evaluate(() => {
        const capture = new MutationObserver(() => {
          if (!document.querySelector("main")?.textContent?.includes("No pending approval requests.")) return;
          document.documentElement.dataset.approvalResultFocused = String(!!document.activeElement?.closest("[role=tabpanel]"));
          capture.disconnect();
        });
        capture.observe(document.querySelector("main")!, { childList: true, subtree: true });
      });
      await app.page.keyboard.press("Enter");
      await app.page.getByText("No pending approval requests.").waitFor();
      assert.equal(await app.page.evaluate(() => document.documentElement.dataset.approvalResultFocused), "true", "result must retain focus in its first DOM commit");
      const inPanel = await app.page.evaluate(() => !!document.activeElement?.closest("[role=tabpanel]"));
      assert.ok(inPanel, "the card is gone; focus must not fall back to <body>");
      const live = await app.page.locator("[role=status]", { hasText: /approved/i }).count();
      assert.ok(live >= 1, "the outcome is announced in a status region");
    });
  });
});

describe("Approvals: errors are sentences, not server text", opts, () => {
  const RAW = "ECONNREFUSED 10.0.0.5:5432 at pg.connect (/srv/plur1bus/db.ts:41)";
  test("a failed decision, cancellation and revocation show a localized sentence in an alert (German)", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedApprovals(app.server.rpc);
      for (const m of ["approval.decide", "approval.cancel", "grant.revoke"]) app.server.rpc.handle(m, () => { throw rpcError("E_INTERNAL", RAW); });
      await openRoute(app.page, "#/approvals", "de");
      await app.page.getByRole("button", { name: "Freigeben" }).click();
      await app.page.locator("[role=alert]:not(:empty)").first().waitFor();
      let text = (await app.page.locator("[role=alert]:not(:empty)").first().textContent()) ?? "";
      assert.ok(!text.includes("ECONNREFUSED"), `raw server text shown: ${text}`);
      assert.match(text, /Entscheidung/);
      await app.page.getByRole("button", { name: "Anfrage abbrechen" }).click();
      await app.page.waitForFunction(() => /abgebrochen/.test(document.querySelector("[role=alert]:not(:empty)")?.textContent ?? ""));
      text = (await app.page.locator("[role=alert]:not(:empty)").first().textContent()) ?? "";
      assert.ok(!text.includes("ECONNREFUSED") && !/Could not/.test(text), `got: ${text}`);
      await app.page.getByRole("tab", { name: "Aktive Grants" }).click();
      await app.page.getByRole("button", { name: "Grant widerrufen" }).click();
      await app.page.locator("[role=alert]:not(:empty)").first().waitFor();
      text = (await app.page.locator("[role=alert]:not(:empty)").first().textContent()) ?? "";
      assert.ok(!text.includes("ECONNREFUSED") && !/Revoke failed/.test(text), `got: ${text}`);
      assert.match(text, /widerrufen/);
    });
  });

  test("an approval that was decided elsewhere says so and reloads the list", async () => {
    await withApp({}, async (app) => {
      seedApprovals(app.server.rpc);
      app.server.rpc.handle("approval.decide", () => { throw rpcError("E_DENIED", "approval-used: already decided by usr_other", "approval-used"); });
      await openRoute(app.page, "#/approvals");
      await approveBtn(app.page).click();
      await app.page.locator("[role=alert]", { hasText: /already been decided|expired/i }).waitFor();
      await waitFor(app, "approval.list", 2);
    });
  });

  test("the grants table header is translated when the page is opened directly", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedApprovals(app.server.rpc);
      await openRoute(app.page, "#/approvals", "de");
      await app.page.getByRole("tab", { name: "Aktive Grants" }).click();
      await app.page.locator(".grants-table").waitFor();
      const heads = await app.page.locator(".grants-table th").allInnerTexts();
      assert.equal(heads.length, 7);
      for (const hd of heads) assert.ok(hd.trim() !== "" && !/^[a-z]+\.[a-z.]+$/.test(hd), `header "${hd}"`);
      assert.equal(heads[6], "Aktion");
    });
  });
});

describe("Approvals: credentials in the details", opts, () => {
  test("summary, targets and the agent's reason show no credentials, and say that something is hidden", async () => {
    await withApp({}, async (app) => {
      const s = secret();
      const apr = { ...sampleApprovals[0]!, summary: `curl -H "Authorization: Bearer ${s}" https://example.test/x`, targets: [`https://bob:${s}@example.test/r.git`], agentReason: `I use API_TOKEN=${s} to fetch the data.` };
      seedApprovals(app.server.rpc, [apr]);
      await openRoute(app.page, "#/approvals");
      await app.page.locator(".approval-summary").waitFor();
      const body = (await app.page.locator(".approval-card-d109").textContent()) ?? "";
      assert.ok(!body.includes(s), "a credential is on the page");
      assert.ok(body.includes("example.test/x") && body.includes("bob:"), "the action stays readable");
      await app.page.getByText("Parts that look like credentials are hidden.").waitFor();
    });
  });
});

