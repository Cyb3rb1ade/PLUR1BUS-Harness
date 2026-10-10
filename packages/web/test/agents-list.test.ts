// Agents page (K3): list and detail states, role, keyboard, layout, a11y, German. Mock /rpc (test/agents-fixtures.ts).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { callsOf, installAgents, world, type World } from "./agents-fixtures.ts";
import { expectAxeClean } from "./axe.ts";
import { rpcError } from "./mock-rpc.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function open(app: App, hash = "#/agents", w: World = world(), lang: "en" | "de" = "en"): Promise<World> {
  installAgents(app.server, w);
  await openRoute(app.page, hash, lang);
  return w;
}

describe("agents: list", opts, () => {
  test("loading, then name, id, created, skills count and state per agent", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server); app.server.rpc.setDelay("config.get", 300);
      await openRoute(app.page, "#/agents");
      await app.page.getByRole("heading", { name: "Agents", level: 1 }).waitFor();
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      const main = app.page.getByRole("link", { name: /Main/ });
      await main.waitFor();
      const text = (await main.textContent()) ?? "";
      assert.match(text, /main/); assert.match(text, /Sep 1, 2026/); assert.match(text, /2 skills/); assert.match(text, /Active/);
      const scribe = (await app.page.getByRole("link", { name: /Scribe/ }).textContent()) ?? "";
      assert.match(scribe, /Archived/); assert.match(scribe, /0 skills/);
      assert.equal((await callsOf(app.server, "config.get"))[0] !== undefined, true);
      assert.deepEqual((callsOf(app.server, "config.get")[0] as { params: unknown }).params, { key: "agents" });
      await app.page.getByRole("link", { name: "Create agent" }).waitFor();
    });
  });
  test("empty list explains and offers Create agent", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/agents", world({ agents: {} }));
      const empty = app.page.locator(".page-state[data-state=empty]");
      await empty.getByRole("heading", { name: "No agents yet" }).waitFor();
      await empty.getByRole("link", { name: "Create agent" }).waitFor();
    });
  });
  test("error offers Try again; forbidden; unavailable (scenario and RPC missing)", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server); app.server.rpc.scenario("config.get", "error");
      await openRoute(app.page, "#/agents");
      await app.page.getByRole("alert").getByRole("heading", { name: "Something went wrong" }).waitFor();
      app.server.rpc.scenario("config.get", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await app.page.getByRole("link", { name: /Main/ }).waitFor();
    });
    await withApp({}, async (app) => {
      installAgents(app.server); app.server.rpc.scenario("config.get", "forbidden");
      await openRoute(app.page, "#/agents");
      await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
    });
    await withApp({}, async (app) => {
      installAgents(app.server); app.server.rpc.scenario("config.get", "unavailable");
      await openRoute(app.page, "#/agents");
      await app.page.getByRole("heading", { name: "Agents are not available" }).waitFor();
    });
    await withApp({}, async (app) => {
      app.server.rpc.enable();
      await openRoute(app.page, "#/agents");
      await app.page.getByRole("heading", { name: "Agents are not available" }).waitFor();
    });
  });
  test("a configuration without the agents key (E_NOT_FOUND) reads as empty", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server, world({ agents: {} }));
      app.server.rpc.handle("config.get", (p) => {
        if ((p as { key?: string } | undefined)?.key === "agents") throw rpcError("E_NOT_FOUND", "no key", "key-unknown");
        return { key: null, tier: null, value: {}, restartClass: null, restart: null, revision: "r1" };
      }, { write: false });
      await openRoute(app.page, "#/agents");
      await app.page.getByRole("heading", { name: "No agents yet" }).waitFor();
    });
  });
});

describe("agents: detail", opts, () => {
  test("facts, skills and the lifecycle actions", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/agents/main");
      const d = app.page.getByRole("region", { name: "Agent details" });
      await d.getByRole("heading", { name: "Main", level: 2 }).waitFor();
      const text = (await d.textContent()) ?? "";
      assert.match(text, /ID\s*main/); assert.match(text, /web-search/); assert.match(text, /calendar/);
      for (const n of ["Pause", "Archive", "Export bundle"]) assert.equal(await d.getByRole("button", { name: n }).getAttribute("aria-disabled"), null, `${n} is wired`);
      assert.equal(await d.getByRole("button", { name: "Delete" }).getAttribute("aria-disabled"), "true", "delete needs an archived agent");
      assert.equal(await app.page.getByRole("link", { name: /Main/ }).first().getAttribute("aria-current"), "true");
    });
  });
  test("unknown id is a not-found state with a way back", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/agents/ghost");
      await app.page.getByRole("heading", { name: "Agent not found" }).waitFor();
      await app.page.getByRole("link", { name: "Back to agents" }).waitFor();
    });
  });
  test("selecting a row opens the detail", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByRole("link", { name: /Scribe/ }).click();
      assert.equal(await app.page.evaluate(() => location.hash), "#/agents/scribe");
      await app.page.getByRole("heading", { name: "Scribe", level: 2 }).waitFor();
    });
  });
});

describe("agents: role, keyboard, layout, a11y", opts, () => {
  test("an operator can view but not create; the lifecycle actions give the role as the reason", async () => {
    await withApp({ server: { role: "operator" } }, async (app) => {
      await open(app, "#/agents/main");
      await app.page.getByText("Only owners and admins can create or change agents.").waitFor();
      assert.equal(await app.page.getByRole("link", { name: "Create agent" }).count(), 0);
      await app.page.getByText("Only owners and admins can do this.").first().waitFor();
    });
    await withApp({ server: { role: "operator" } }, async (app) => {
      await open(app, "#/agents/new");
      await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
    });
    await withApp({ server: { role: "admin" } }, async (app) => {
      await open(app);
      await app.page.getByRole("link", { name: "Create agent" }).waitFor();
    });
  });
  test("arrow keys move between rows", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const rows = app.page.locator("a.a-row");
      await rows.nth(0).focus();
      await app.page.keyboard.press("ArrowDown");
      assert.equal(await rows.nth(1).evaluate((e) => e === document.activeElement), true);
      await app.page.keyboard.press("ArrowUp");
      assert.equal(await rows.nth(0).evaluate((e) => e === document.activeElement), true);
      await app.page.keyboard.press("End");
      assert.equal(await rows.nth(1).evaluate((e) => e === document.activeElement), true);
    });
  });
  test("axe clean: list, detail, empty, not found", async () => {
    await withApp({}, async (app) => {
      await open(app); await app.page.getByRole("link", { name: /Main/ }).waitFor();
      await expectAxeClean(app.page, "agents list");
      await app.page.getByRole("link", { name: /Main/ }).click();
      await app.page.getByRole("heading", { name: "Main", level: 2 }).waitFor();
      await expectAxeClean(app.page, "agents detail");
      await app.page.evaluate(() => { location.hash = "#/agents/ghost"; });
      await app.page.getByRole("heading", { name: "Agent not found" }).waitFor();
      await expectAxeClean(app.page, "agents not found");
    });
    await withApp({}, async (app) => {
      await open(app, "#/agents", world({ agents: {} }));
      await app.page.getByRole("heading", { name: "No agents yet" }).waitFor();
      await expectAxeClean(app.page, "agents empty");
    });
  });
  test("400 px and 200 % zoom (narrow 640 px viewport): no horizontal page scroll, detail replaces the list", async () => {
    for (const width of [400, 640]) {
      await withApp({ width, height: 800 }, async (app) => {
        await open(app); await app.page.getByRole("link", { name: /Main/ }).waitFor();
        const over = (): Promise<boolean> => app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        assert.equal(await over(), false, `list at ${width}`);
        await app.page.getByRole("link", { name: /Main/ }).click();
        await app.page.getByRole("heading", { name: "Main", level: 2 }).waitFor();
        assert.equal(await over(), false, `detail at ${width}`);
        await expectAxeClean(app.page, `agents detail at ${width}`);
      });
    }
  });
  test("German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      await open(app, "#/agents/main", world(), "de");
      await app.page.getByRole("heading", { name: "Agenten", level: 1 }).waitFor();
      await app.page.getByRole("button", { name: "Pausieren" }).waitFor();
      await app.page.getByRole("link", { name: "Agent anlegen" }).waitFor();
    });
  });
});
