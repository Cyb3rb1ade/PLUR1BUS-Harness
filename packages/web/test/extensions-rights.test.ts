import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setLangPref } from "../src/i18n.ts";
import { rightRows } from "../src/pages/extensions/rights.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { seedExtensions } from "./surfaces-fixtures.ts";

test("rightRows: lists every requested right; hostBridge and mcpApps are their own highlighted rows", () => {
  setLangPref("en");
  const rows = rightRows({
    network: { mode: "allowlist", hosts: ["api.example.org"] },
    filesystem: [{ scope: "extension-data", access: "read-write" }],
    processes: { spawn: true, commands: ["git"] },
    secrets: [{ slot: "TOKEN", label: { en: "x" }, required: true }],
    harness: { authority: "scoped", rpc: ["memory.search"] },
    tools: [{ name: "search", effect: "read" }],
    hostBridge: ["computer-use", "keychain"],
    mcpApps: true,
    futureThing: 1,
  });
  const ids = rows.map((r) => r.id);
  for (const id of ["network", "processes", "secret:TOKEN", "harness", "tool:search", "hostBridge", "mcpApps", "other:futureThing"]) assert.ok(ids.includes(id), id);
  const hb = rows.find((r) => r.id === "hostBridge")!;
  assert.equal(hb.highlight, true);
  assert.equal(hb.risk, "high");
  assert.match(hb.value, /computer-use, keychain/);
  assert.equal(rows.find((r) => r.id === "mcpApps")!.highlight, true);
  assert.equal(rows.filter((r) => r.highlight).length, 2);
});

test("rightRows: absent rights stay absent", () => {
  assert.deepEqual(rightRows({ network: { mode: "none" }, mcpApps: false, hostBridge: [] }).map((r) => r.id), ["network"]);
  assert.deepEqual(rightRows(null), []);
});

before(setup);
after(teardown);

describe("Extensions rights in the browser", { skip: browserSkip }, () => {
  test("enable dialog shows hostBridge and mcpApps before Enable now becomes operable", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      await openRoute(app.page, "#/plugins");
      await app.page.getByRole("button", { name: /telegram-channel/i }).click();
      await app.page.getByRole("heading", { name: "telegram-channel", level: 2 }).waitFor();
      // The detail view already lists the rights.
      await app.page.locator('[data-right="hostBridge"]').first().waitFor();

      await app.page.getByRole("button", { name: /^Disable$/i }).click();
      await app.page.getByRole("button", { name: /^Enable$/i }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      const hostBridge = dlg.locator('[data-right="hostBridge"]');
      await hostBridge.waitFor({ state: "visible" });
      await dlg.locator('[data-right="mcpApps"]').waitFor({ state: "visible" });
      const submit = dlg.getByRole("button", { name: /Enable now/i });
      assert.equal(await submit.isDisabled(), true, "not operable before the rights are acknowledged");
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "ext.enable").length, 0);
      await dlg.getByRole("checkbox").check();
      assert.equal(await submit.isDisabled(), false);
      // Closing the dialog precedes the asynchronous CSRF exchange and mutation. Observe the actual RPC response.
      const enabled = app.page.waitForResponse(response => response.url().endsWith("/rpc") && response.status() === 200 && response.request().postDataJSON()?.method === "ext.enable");
      await submit.click();
      await enabled;
      await dlg.waitFor({ state: "detached" });
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "ext.enable").length, 1);
    });
  });
});
