// Settings > Modules & Updates (`/settings/modules`): the list with state and dependencies, start/stop/restart behind a confirmation
// that names the modules a stop takes down with it, the typed uninstall, install (Owner), roles (Owner and Admin act, the Viewer reads),
// the unavailable state, the live hint from module.state, the failure text, German and axe.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const child = (state: string, restarts = 0) => ({
  role: "module", process: { state }, pid: 4242, instanceId: "i-1", adopted: false, restarts, lastExit: null, nextRestartAt: null,
});
type Entry = { name: string; needs: string[]; consumes?: string[]; enabled?: boolean; child: ReturnType<typeof child> | null; version?: string | null };
const entry = (e: Entry) => ({
  name: e.name, version: e.version === undefined ? "1.0.0" : e.version, apiVersion: "1", priority: 500, band: "x", scope: "installation",
  provides: [], consumes: e.consumes ?? [], needs: e.needs, enabled: e.enabled ?? true, errors: [], child: e.child, detail: null,
});
const MODULES = [
  entry({ name: "fixture", needs: ["core"], child: child("ready") }),
  entry({ name: "digest", needs: ["fixture"], version: "1.2.0", child: child("ready", 2) }),
  entry({ name: "report", needs: ["digest"], child: child("stopped") }),
  entry({ name: "search", needs: [], consumes: ["memory"], enabled: false, child: null }),
];
const edge = (from: string, to: string, kind: "needs" | "consumes" = "needs") => ({ from, to, kind, ...(kind === "consumes" ? { capability: "memory" } : {}) });
const node = (name: string) => ({ name, version: "1.0.0", priority: 500, band: "x", scope: "installation", extensionPoints: {}, valid: true });
// digest needs fixture; report and search both depend on digest (search through a consumes edge): stopping fixture takes all three down.
const GRAPH = {
  nodes: [node("core"), node("fixture"), node("digest"), node("report"), node("search")],
  edges: [edge("fixture", "core"), edge("digest", "fixture"), edge("report", "digest"), edge("search", "digest", "consumes")],
  cycles: [],
  unresolved: [],
};

function seed(app: App, modules = MODULES): void {
  app.server.rpc.handle("module.list", () => ({ modules }), { write: false });
  app.server.rpc.handle("module.graph", () => GRAPH, { write: false });
  app.server.rpc.handle("module.watch", () => ({ subscriptionId: "sub-1", modules: [] }), { write: false });
  app.server.rpc.handle("ext.list", () => ({ items: [] }), { write: false });
}

async function open(app: App, lang: "en" | "de" = "en"): Promise<void> {
  await openRoute(app.page, "#/settings/modules", lang);
  await app.page.getByRole("heading", { name: lang === "de" ? "Module & Updates" : "Modules & Updates", level: 2 }).waitFor();
}
const list = (app: App) => app.page.getByRole("list", { name: "Installed modules" });
const rowOf = (app: App, name: string) => app.page.locator(`[data-module="${name}"]`);
const callsOf = (app: App, method: string): unknown[] => app.server.rpc.calls.filter((c) => c.method === method).map((c) => c.params);

describe("modules: list", opts, () => {
  test("lists every module with state, version, enabled flag and what it depends on or is needed by", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      assert.equal(await list(app).getByRole("listitem").count(), 4);
      const fixture = (await rowOf(app, "fixture").textContent()) ?? "";
      assert.match(fixture, /fixture/); assert.match(fixture, /1\.0\.0/); assert.match(fixture, /Running/); assert.match(fixture, /Enabled/);
      assert.match(fixture, /Depends on: core/); assert.match(fixture, /Needed by: digest/);
      const digest = (await rowOf(app, "digest").textContent()) ?? "";
      assert.match(digest, /1\.2\.0/); assert.match(digest, /Restarts: 2/);
      const search = (await rowOf(app, "search").textContent()) ?? "";
      assert.match(search, /Not running/); assert.match(search, /Disabled in the configuration/); assert.match(search, /Depends on: digest/); assert.match(search, /Needed by: none/);
      assert.match((await rowOf(app, "report").textContent()) ?? "", /Stopped/);
      assert.equal(await app.page.getByRole("link", { name: "Modules & Updates" }).getAttribute("aria-current"), "true");
      assert.deepEqual(app.problems, [], "no console error or CSP violation");
    });
  });

  test("a running module offers stop and restart; a stopped one offers start", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Stop: fixture" }).count(), 1);
      assert.equal(await app.page.getByRole("button", { name: "Restart: fixture" }).count(), 1);
      assert.equal(await app.page.getByRole("button", { name: "Start: report" }).count(), 1);
      assert.equal(await app.page.getByRole("button", { name: "Start: search" }).count(), 1);
    });
  });

  test("the graph failing does not hide the modules; the note says there are no dependencies", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("module.graph", "unavailable");
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await app.page.getByText("The dependency list is not available").waitFor();
      assert.match((await rowOf(app, "fixture").textContent()) ?? "", /Depends on: none/);
    });
  });

  test("no module installed shows the empty state", async () => {
    await withApp({}, async (app) => {
      seed(app, []);
      await open(app);
      await app.page.getByRole("heading", { name: "No modules installed" }).waitFor();
    });
  });

  test("module.list not served here: the unavailable state", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("module.list", "unavailable");
      await openRoute(app.page, "#/settings/modules");
      await app.page.getByRole("heading", { name: "Modules are not available on this harness" }).waitFor();
    });
  });
});

describe("modules: start, stop, restart", opts, () => {
  test("stop names the modules that depend on it, directly or through others, and sends module.stop after confirm", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.handle("module.stop", () => ({ accepted: true, name: "fixture" }));
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await app.page.getByRole("button", { name: "Stop: fixture" }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByRole("heading", { name: "Stop fixture?" }).waitFor();
      const affected = dialog.getByRole("list");
      assert.deepEqual(await affected.getByRole("listitem").allTextContents(), ["digest", "report", "search"]);
      assert.deepEqual(callsOf(app, "module.stop"), []);
      await dialog.getByRole("button", { name: "Stop", exact: true }).click();
      await app.page.getByRole("status").filter({ hasText: "fixture stopped." }).waitFor();
      assert.deepEqual(callsOf(app, "module.stop"), [{ name: "fixture" }]);
      assert.equal(await app.page.getByRole("dialog").count(), 0);
    });
  });

  test("restart names the dependents; a module nobody depends on says so; cancel sends nothing", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await app.page.getByRole("button", { name: "Restart: digest" }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByRole("heading", { name: "Restart digest?" }).waitFor();
      assert.deepEqual(await dialog.getByRole("listitem").allTextContents(), ["report", "search"]);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      assert.equal(await app.page.getByRole("dialog").count(), 0);
      assert.deepEqual(callsOf(app, "module.restart"), []);
    });
    await withApp({}, async (app) => {
      // report is running here: a restart of a module nobody depends on
      seed(app, MODULES.map((m) => (m.name === "report" ? entry({ name: "report", needs: ["digest"], child: child("ready") }) : m)));
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await app.page.getByRole("button", { name: "Restart: report" }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByRole("heading", { name: "Restart report?" }).waitFor();
      await dialog.getByText("No other module depends on report.").waitFor();
    });
  });

  test("a failing action keeps the dialog open and says why", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.handle("module.stop", () => { throw rpcError("E_NOT_AVAILABLE", "cannot stop", "needs-unavailable"); });
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await app.page.getByRole("button", { name: "Stop: fixture" }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Stop", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "The action failed: cannot stop (needs-unavailable)" }).waitFor();
      assert.equal(await app.page.getByRole("dialog").count(), 1);
    });
  });
});

describe("modules: uninstall and install", opts, () => {
  test("uninstall needs the module name typed before the confirm button works", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.handle("module.uninstall", () => ({ name: "search", removed: true }));
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await app.page.getByRole("button", { name: "Uninstall: search" }).click();
      const dialog = app.page.getByRole("dialog");
      const go = dialog.getByRole("button", { name: "Uninstall", exact: true });
      assert.equal(await go.isDisabled(), true);
      await dialog.locator("#confirm-typed").fill("sear");
      assert.equal(await go.isDisabled(), true);
      await dialog.locator("#confirm-typed").fill("search");
      assert.equal(await go.isDisabled(), false);
      await go.click();
      await app.page.getByRole("status").filter({ hasText: "search uninstalled." }).waitFor();
      assert.deepEqual(callsOf(app, "module.uninstall"), [{ name: "search" }]);
    });
  });

  test("the owner uploads bytes and reviews an owned inspection without sending a host path", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.handle("ext.inspect", params => { assert.deepEqual(params, { source: { upload: "U".repeat(43) } }); return { inspectionId: "module-inspection" }; });
      app.server.rpc.handle("ext.inspection.get", () => ({ inspectionId: "module-inspection", expiresAt: "2099-01-01T00:00:00Z", sha256: "a".repeat(64), manifest: { id: "fixture/clock", kind: "module", version: "0.1.0", licence: "MIT" }, trust: { tier: "unsigned" }, checks: [], scripts: [], requires: {}, capabilities: {} }), { write: false });
      app.server.rpc.handle("agent.list", () => ({ agents: [] }), { write: false });
      app.server.extensions.push((req, res, path, body) => {
        if (path !== "/api/v1/extensions/upload") return false;
        const session = app.server.sessionOf(req), csrf = req.headers["x-csrf-token"];
        assert.ok(session && typeof csrf === "string" && session.csrf.delete(csrf));
        assert.match(body, /module package bytes/);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ uploadId: "U".repeat(43), expiresAt: Date.now() + 600000, sha256: "a".repeat(64) })); return true;
      });
      await open(app);
      await app.page.getByRole("button", { name: "Install from file", exact: true }).click();
      await app.page.locator("#ext-file-input").setInputFiles({ name: "clock.p1x", mimeType: "application/octet-stream", buffer: Buffer.from("module package bytes") });
      await app.page.getByRole("heading", { name: "Confirm extension installation" }).waitFor();
      assert.deepEqual(callsOf(app, "module.install"), []);
      assert.deepEqual(callsOf(app, "ext.install"), []);
    });
  });
});

describe("modules: roles", opts, () => {
  test("admin can operate modules and install extensions; native module uninstall remains owner-only", async () => {
    await withApp({ server: { role: "admin" } }, async (app) => {
      seed(app);
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Stop: fixture" }).count(), 1);
      assert.equal(await app.page.getByRole("button", { name: /^Uninstall:/ }).count(), 0);
      assert.equal(await app.page.getByRole("button", { name: "Install from file", exact: true }).count(), 1);
    });
  });

  test("a viewer reads the list and sees no action at all", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seed(app);
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await app.page.getByText("Read-only for your role.").waitFor();
      assert.equal(await app.page.getByRole("button", { name: /^(Stop|Start|Restart|Uninstall):/ }).count(), 0);
      assert.equal(await app.page.getByRole("button", { name: "Install from file", exact: true }).count(), 0);
      assert.equal(callsOf(app, "ext.list").length, 0);
      assert.equal(callsOf(app, "module.stop").length, 0);
    });
  });
});

describe("modules: live hint and German", opts, () => {
  test("a module.state notification shows a hint with reload; it does not change the list by itself", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.events.enable();
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await app.server.events.waitForConnections(1);
      app.server.rpc.handle("module.list", () => ({ modules: [...MODULES.slice(0, 3)] }), { write: false });
      app.server.events.push({ event: "module.state", data: { name: "search" } });
      await app.page.getByText("A module changed state, so the list may be out of date.").waitFor();
      assert.equal(await list(app).getByRole("listitem").count(), 4, "the list is not touched before a reload");
      await app.page.getByRole("button", { name: "Reload" }).click();
      await list(app).getByRole("listitem").nth(2).waitFor();
      await app.page.getByText("A module changed state").waitFor({ state: "detached" });
      await rowOf(app, "search").waitFor({ state: "detached" });
      assert.equal(await list(app).getByRole("listitem").count(), 3);
    });
  });

  test("German: the section, the buttons with their module and the confirmation", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app);
      await open(app, "de");
      const deList = app.page.getByRole("list", { name: "Installierte Module" });
      await deList.getByRole("listitem").nth(3).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Starten: report" }).count(), 1);
      await app.page.getByRole("button", { name: "Stoppen: fixture" }).click();
      await app.page.getByRole("dialog").getByRole("heading", { name: "fixture stoppen?" }).waitFor();
      await app.page.getByRole("dialog").getByText("Mitbetroffen, weil sie von fixture abhängen:").waitFor();
      await app.page.getByRole("dialog").getByRole("button", { name: "Abbrechen" }).click();
    });
  });
});

describe("modules: accessibility", opts, () => {
  test("axe is clean with the list, and with the stop confirmation open", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await open(app);
      await list(app).getByRole("listitem").nth(3).waitFor();
      await expectAxeClean(app.page, "modules list");
      await app.page.getByRole("button", { name: "Stop: fixture" }).click();
      await app.page.getByRole("dialog").waitFor();
      await expectAxeClean(app.page, "modules stop confirmation");
    });
  });
});

 test("cached module updates show versions, blocks and check time", opts, async () => {
  await withApp({}, async (app) => {
    seed(app);
    app.server.rpc.handle("module.list", () => ({ modules: [
      {...MODULES[0], availableVersion:"1.1.0", feedCheckedAt:"2026-10-14T10:00:00Z"},
      {...MODULES[1], updateBlockedReason:"signature", feedCheckedAt:"2026-10-14T10:00:00Z"},
      {...MODULES[2], updateBlockedReason:"minFromVersion", feedCheckedAt:"2026-10-14T10:00:00Z"},
    ]}), {write:false});
    await open(app);
    await app.page.getByText("Update available: 1.1.0", {exact:true}).waitFor();
    await app.page.getByText("Update blocked: the feed signature could not be verified.", {exact:true}).waitFor();
    await expectAxeClean(app.page, "module update metadata");
  });
 });
