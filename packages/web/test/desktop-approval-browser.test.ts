/** The approval page sends only a public code and an explicit decision over the ordinary cookie/CSRF session. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);

test("desktop approval reviews a public request before the human explicitly approves it with session CSRF", { skip: browserSkip }, async () => {
  await withApp({}, async (app) => {
    const userCode = "ABCD-EFGH";
    let decisions = 0;
    app.server.extensions.push((req, res, path, body) => {
      if (!path.startsWith("/api/v1/desktop/step-up/")) return false;
      const session = app.server.sessionOf(req);
      assert.ok(session, "the ordinary authenticated cookie is required");
      assert.equal(req.headers.authorization, undefined, "native credentials have no browser interface");
      const result = {
        userCode,
        deviceId: "desktop-fixture",
        purpose: "imports",
        state: "pending",
        expiresAt: Date.now() + 60_000,
      };
      if (path === `/api/v1/desktop/step-up/approval/${userCode}`) {
        assert.equal(req.method, "GET");
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ schema: "desktop.step-up.approval/1", ...result }));
      } else {
        assert.equal(path, "/api/v1/desktop/step-up/decision");
        assert.equal(req.method, "POST");
        assert.deepEqual(JSON.parse(body), { userCode, decision: "approve" });
        const csrf = req.headers["x-csrf-token"];
        assert.ok(
          typeof csrf === "string" && session.csrf.delete(csrf),
          "the explicit decision spends real session CSRF",
        );
        decisions++;
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ schema: "desktop.step-up.decision/1", ...result, state: "approved" }));
      }
      return true;
    });
    await openRoute(app.page, "#/desktop/approve");
    await app.page.getByRole("heading", { name: "Approve desktop access", exact: true }).waitFor();
    await app.page.getByLabel("Desktop verification code", { exact: true }).fill(userCode);
    await app.page.getByRole("button", { name: "Review request", exact: true }).click();
    const approve = app.page.getByRole("button", { name: "Approve this device request", exact: true });
    await approve.waitFor();
    assert.equal(decisions, 0, "review alone grants nothing");
    await expectAxeClean(app.page, "ordinary account desktop approval review");
    await approve.click();
    await app.page.getByText("Approved. Return to the desktop app to continue.", { exact: true }).waitFor();
    assert.equal(decisions, 1);
    assert.equal(await approve.count(), 0);
    assert.deepEqual(app.problems, []);
  });
});
