import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { seedApprovals, sampleApprovals } from "./surfaces-fixtures.ts";
import { expectAxeClean } from "./axe.ts";
before(setup); after(teardown);
test("approval explains pending OS confirmation without initiating a decision", { skip: browserSkip }, async () => {
  await withApp({}, async app => {
    seedApprovals(app.server.rpc, [{ ...sampleApprovals[0]!, osConfirmation: { required: true, status: "pending", platform: "touchid" } }]);
    await openRoute(app.page, "#/approvals");
    await app.page.getByText(/OS confirmation pending/).waitFor();
    assert.ok((await app.page.locator("main").innerText()).includes("Confirm on the device to continue."));
    assert.equal(app.server.rpc.calls.filter(c => c.method === "approval.decide").length, 0);
    await expectAxeClean(app.page, "OS confirmation pending");
  });
});
