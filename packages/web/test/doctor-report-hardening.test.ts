// Doctor "live provisioning report" hardening (audit c20): a report in an unexpected shape must not take the card down, and a
// double click on "Refresh provisioning" sends one refresh.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { DoctorMock } from "./doctor-fixtures.ts";
import { parseReport } from "../src/pages/doctor/report.ts";

before(setup);
after(teardown);

describe("doctor report: reader", () => {
  test("anything that is not { groups: [...] } is null", () => {
    for (const v of [null, undefined, 7, "x", [], {}, { groups: "no" }, { groups: {} }]) assert.equal(parseReport(v), null);
  });
  test("checks without id or summary are dropped, an unknown status is shown as skipped, a missing title falls back to the id", () => {
    const r = parseReport({ groups: [
      { id: "provisioning", checks: [
        { id: "a", status: "ok", summary: "fine", repair: { kind: "hint", label: "Do x" } },
        { id: "b", status: "info", summary: "new status" },
        { status: "ok", summary: "no id" },
        { id: "c", status: "ok" },
        { id: "d", status: "warn", summary: "w", repair: { kind: "hint" } },
      ] },
      { checks: [] },
      { id: "empty", title: "Empty", checks: [] },
    ] });
    assert.deepEqual(r, { groups: [
      { id: "provisioning", title: "provisioning", checks: [
        { id: "a", status: "ok", summary: "fine", repair: { label: "Do x" } },
        { id: "b", status: "skipped", summary: "new status" },
        { id: "d", status: "warn", summary: "w" },
      ] },
      { id: "empty", title: "Empty", checks: [] },
    ] });
  });
});

describe("doctor report: in the browser", { skip: browserSkip }, () => {
  test("an answer of the wrong shape says the report is unavailable; the rest of the page stays", async () => {
    await withApp({}, async (app) => {
      new DoctorMock(app.server);
      app.server.rpc.handle("doctor.report", () => ({ ok: true }), { write: false });
      await openRoute(app.page, "#/doctor");
      await app.page.getByText("The live provisioning report is unavailable.").waitFor();
      await app.page.getByRole("button", { name: "Re-check" }).waitFor();
    });
  });

  test("two clicks in the same tick on Refresh provisioning send one refresh and show no failure", async () => {
    await withApp({}, async (app) => {
      new DoctorMock(app.server);
      let refreshes = 0;
      app.server.rpc.handle("doctor.report", async (p) => {
        if ((p as { refresh?: boolean } | undefined)?.refresh) {
          refreshes += 1;
          if (refreshes > 1) throw new Error("rate limited");
          await new Promise((r) => setTimeout(r, 300));
        }
        return { groups: [{ id: "provisioning", title: "Provisioning", checks: [{ id: "models.cache", status: "ok", summary: "cache ok" }] }] };
      }, { write: true });
      await openRoute(app.page, "#/doctor");
      await app.page.getByText(/cache ok/).waitFor();
      await app.page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Refresh provisioning")!;
        b.click(); b.click();
      });
      await app.page.waitForFunction(() => ![...document.querySelectorAll("button")].some((x) => x.textContent === "Refresh provisioning" && x.disabled));
      assert.equal(refreshes, 1);
      assert.equal(await app.page.getByText("Refresh failed or was requested within 30 seconds.").count(), 0);
    });
  });
});
