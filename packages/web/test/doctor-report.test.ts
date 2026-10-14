import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { DoctorMock } from "./doctor-fixtures.ts";
import { expectAxeClean } from "./axe.ts";
before(setup); after(teardown);
test("viewer reads live provisioning statuses and repair hints with no refresh action", { skip: browserSkip }, async () => {
  await withApp({ server: { role: "viewer" } }, async app => {
    new DoctorMock(app.server);
    app.server.rpc.handle("doctor.report", () => ({ generatedAt: "2026-10-14T10:00:00.000Z", groups: [{ id: "provisioning", title: "Provisioning", checks: [{ id: "models.cache", status: "warn", summary: "Model cache needs attention", repair: { kind: "hint", label: "Review installed models" } }] }] }), { write: false });
    await openRoute(app.page, "#/doctor");
    await app.page.getByText(/Model cache needs attention/).waitFor();
    await app.page.getByText("Review installed models", { exact: true }).waitFor();
    assert.equal(await app.page.getByRole("button", { name: "Refresh provisioning", exact: true }).count(), 0);
    assert.ok(app.server.rpc.calls.some(c => c.method === "doctor.report"));
    await expectAxeClean(app.page, "live provisioning viewer");
  });
});
