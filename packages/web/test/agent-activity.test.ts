import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { installActivity } from "./activity-fixtures.ts";
import { expectAxeClean } from "./axe.ts";
before(setup); after(teardown);
test("viewer can filter and page agent transitions without reading protected logs", { skip: browserSkip }, async () => {
  await withApp({ server: { role: "viewer" } }, async app => {
    installActivity(app.server);
    app.server.rpc.handle("agent.activity.list", p => {
      const params = p as { cursor?: string };
      return { items: [{ id: params.cursor ? "transition-2" : "transition-1", agentId: "scribe", activity: { state: "recalling", since: 1000 } }], ...(params.cursor ? {} : { nextCursor: "page-2" }) };
    }, { write: false });
    await openRoute(app.page, "#/logs/activity");
    const section = app.page.getByRole("region", { name: "Agent activity" });
    await section.getByText(/scribe: Recalling/).waitFor();
    await section.getByLabel("Agent ID").fill("scribe");
    await section.getByRole("button", { name: "Show more" }).click();
    for (let i = 0; i < 50 && !app.server.rpc.calls.some(c => (c.params as {cursor?:string})?.cursor === "page-2"); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(app.server.rpc.calls.some(c => c.method === "agent.activity.list" && (c.params as {agentId?:string;cursor?:string}).agentId === "scribe" && (c.params as {cursor?:string}).cursor === "page-2"));
    assert.equal(app.server.rpc.calls.filter(c => c.method === "logs.query" || c.method === "audit.verify").length, 0);
    await expectAxeClean(app.page, "agent activity viewer");
  });
});
