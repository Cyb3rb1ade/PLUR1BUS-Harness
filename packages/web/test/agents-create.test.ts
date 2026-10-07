// Agents create wizard (K3): steps, validation, uniqueness, client idempotency (double click, retry after error, lost response),
// revision conflict, role, focus, a11y. Mock /rpc (test/agents-fixtures.ts).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { callsOf, installAgents, world, type World } from "./agents-fixtures.ts";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function open(app: App, w: World = world()): Promise<World> {
  installAgents(app.server, w);
  await openRoute(app.page, "#/agents/new");
  await app.page.getByLabel("Name", { exact: true }).waitFor();
  return w;
}
const fillName = async (app: App, name: string, id?: string): Promise<void> => {
  await app.page.getByLabel("Name", { exact: true }).fill(name);
  if (id !== undefined) await app.page.getByLabel("ID", { exact: true }).fill(id);
};
const next = (app: App): Promise<void> => app.page.getByRole("button", { name: "Next" }).click();
async function toReview(app: App, name = "Research Bot", id?: string, skills: string[] = []): Promise<void> {
  await fillName(app, name, id);
  await next(app);
  await app.page.getByRole("heading", { name: /Step 2 of 3/ }).waitFor();
  for (const s of skills) await app.page.getByLabel(s, { exact: true }).check();
  await next(app);
  await app.page.getByRole("heading", { name: /Step 3 of 3/ }).waitFor();
}
const submit = (app: App): Promise<void> => app.page.getByRole("button", { name: "Create agent" }).click();

describe("agents create: steps", opts, () => {
  test("name -> skills -> review -> create writes agents.<id> with ifRevision and opens the detail", async () => {
    await withApp({}, async (app) => {
      const w = await open(app);
      await fillName(app, "Research Bot");
      assert.equal(await app.page.getByLabel("ID", { exact: true }).inputValue(), "research-bot", "id suggested from the name");
      await next(app);
      await app.page.getByRole("group", { name: "Skills (optional)" }).waitFor();
      await app.page.getByLabel("notes", { exact: true }).check();
      await next(app);
      const review = (await app.page.locator(".a-create").textContent()) ?? "";
      assert.match(review, /Research Bot/); assert.match(review, /research-bot/); assert.match(review, /notes/);
      await submit(app);
      await app.page.getByRole("heading", { name: "Research Bot", level: 2 }).waitFor();
      await app.page.getByText("Agent Research Bot was created.").waitFor();
      assert.equal(app.page.url().endsWith("#/agents/research-bot"), true);
      const sets = callsOf(app.server, "config.set");
      assert.equal(sets.length, 1);
      const p = sets[0]!.params as { changes: { key: string; value: { displayName: string; createdAt: string; skills: string[] } }[]; ifRevision: string };
      assert.equal(p.ifRevision, "r1");
      assert.equal(p.changes[0]!.key, "agents.research-bot");
      assert.deepEqual(p.changes[0]!.value.skills, ["notes"]);
      assert.equal(p.changes[0]!.value.displayName, "Research Bot");
      assert.equal(w.agents["research-bot"]?.displayName, "Research Bot");
      await app.page.getByRole("link", { name: /Research Bot/ }).waitFor();
    });
  });
  test("validation: name required, id slug rules, id unique against the list; Back keeps the input", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await next(app);
      await app.page.getByText("Enter a name.").waitFor();
      assert.equal(await app.page.getByLabel("Name", { exact: true }).getAttribute("aria-invalid"), "true");
      await fillName(app, "X", "Bad ID!");
      await next(app);
      await app.page.getByText(/Use lowercase letters, digits/).first().waitFor();
      await app.page.getByLabel("ID", { exact: true }).fill("main");
      await next(app);
      await app.page.getByText("An agent with this ID already exists.").waitFor();
      await app.page.getByLabel("ID", { exact: true }).fill("x-1");
      await next(app);
      await app.page.getByRole("heading", { name: /Step 2 of 3/ }).waitFor();
      await app.page.getByRole("button", { name: "Back" }).click();
      assert.equal(await app.page.getByLabel("ID", { exact: true }).inputValue(), "x-1");
      assert.equal(callsOf(app.server, "config.set").length, 0);
    });
  });
  test("skills step: none installed, failing and missing RPC are notes, the step can be skipped", async () => {
    await withApp({}, async (app) => {
      await open(app, world({ skills: [] }));
      await fillName(app, "A"); await next(app);
      await app.page.getByText("No skills are installed.").waitFor();
      await next(app);
      await app.page.getByRole("heading", { name: /Step 3 of 3/ }).waitFor();
    });
    await withApp({}, async (app) => {
      await open(app); app.server.rpc.scenario("ext.list", "error");
      await fillName(app, "A"); await next(app);
      await app.page.getByText("The installed skills could not be loaded.").waitFor();
    });
    await withApp({}, async (app) => {
      await open(app); app.server.rpc.scenario("ext.list", "unavailable");
      await fillName(app, "A"); await next(app);
      await app.page.getByText(/not available on this harness yet/).waitFor();
    });
  });
  test("focus moves to the step heading on each step", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await fillName(app, "A"); await next(app);
      await app.page.getByRole("heading", { name: /Step 2 of 3/ }).waitFor();
      assert.equal(await app.page.evaluate(() => document.activeElement?.textContent ?? ""), "Step 2 of 3: Skills");
    });
  });
  test("axe clean on every step and with errors; 400 px has no horizontal scroll", async () => {
    await withApp({ width: 400, height: 800 }, async (app) => {
      await open(app);
      await next(app); await app.page.getByText("Enter a name.").waitFor();
      await expectAxeClean(app.page, "create step 1 with errors");
      await fillName(app, "Bot"); await next(app);
      await app.page.getByRole("group", { name: "Skills (optional)" }).waitFor();
      await expectAxeClean(app.page, "create step 2");
      await next(app);
      await app.page.getByRole("heading", { name: /Step 3 of 3/ }).waitFor();
      await expectAxeClean(app.page, "create step 3");
      assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    });
  });
});

describe("agents create: idempotency", opts, () => {
  test("a double click sends one config.set", async () => {
    await withApp({}, async (app) => {
      const w = await open(app);
      app.server.rpc.setDelay("config.set", 300);
      await toReview(app);
      await app.page.getByRole("button", { name: "Create agent" }).dblclick();
      await app.page.getByRole("heading", { name: "Research Bot", level: 2 }).waitFor();
      assert.equal(callsOf(app.server, "config.set").length, 1);
      assert.equal(w.sets, 1);
    });
  });
  test("retry after an error reuses the attempt and succeeds", async () => {
    await withApp({}, async (app) => {
      const w = await open(app);
      await toReview(app);
      app.server.rpc.scenario("config.set", "error");
      await submit(app);
      await app.page.getByRole("alert").getByText(/could not be created/).waitFor();
      assert.equal(w.sets, 0);
      app.server.rpc.scenario("config.set", "success");
      await submit(app);
      await app.page.getByRole("heading", { name: "Research Bot", level: 2 }).waitFor();
      assert.equal(w.sets, 1);
      const [a, b] = callsOf(app.server, "config.set").map((c) => (c.params as { changes: { value: { createdAt: string } }[] }).changes[0]!.value.createdAt);
      assert.equal(a, b, "same attempt, same createdAt");
    });
  });
  test("retry after a lost response reports success without a second write", async () => {
    await withApp({}, async (app) => {
      const w = await open(app);
      await toReview(app);
      // The write lands, the answer is lost.
      const real = w.agents;
      app.server.rpc.handle("config.set", (p) => {
        const q = p as { changes: { key: string; value: never }[] };
        for (const c of q.changes) real[c.key.replace(/^agents\./, "")] = c.value;
        w.revision += 1; w.sets += 1;
        throw rpcError("E_INTERNAL", "connection lost");
      });
      await submit(app);
      await app.page.getByRole("alert").getByText(/could not be created/).waitFor();
      assert.equal(w.sets, 1);
      await submit(app);
      await app.page.getByRole("heading", { name: "Research Bot", level: 2 }).waitFor();
      await app.page.getByText(/already created by an earlier attempt/).waitFor();
      assert.equal(callsOf(app.server, "config.set").length, 1, "the retry wrote nothing");
      assert.equal(w.sets, 1);
    });
  });
  test("an id that appeared meanwhile is reported on the first step, nothing is written", async () => {
    await withApp({}, async (app) => {
      const w = await open(app);
      await toReview(app);
      w.agents["research-bot"] = { displayName: "Someone else", createdAt: "2026-01-01T00:00:00.000Z", skills: [] }; w.revision += 1;
      await submit(app);
      await app.page.getByRole("heading", { name: /Step 1 of 3/ }).waitFor();
      await app.page.getByText("An agent with this ID already exists.").first().waitFor();
      assert.equal(callsOf(app.server, "config.set").length, 0);
    });
  });
  test("revision conflict: nothing written, message shown, the retry reads the new revision", async () => {
    await withApp({}, async (app) => {
      const w = await open(app);
      await toReview(app);
      const get = app.server.rpc.handle.bind(app.server.rpc);
      void get;
      app.server.rpc.handle("config.set", () => { w.revision += 1; throw rpcError("E_CONFLICT", "changed", "config-changed"); });
      await submit(app);
      await app.page.getByRole("alert").getByText(/configuration changed in the meantime/).waitFor();
      assert.equal(w.sets, 0);
      installAgents(app.server, w);
      await submit(app);
      await app.page.getByRole("heading", { name: "Research Bot", level: 2 }).waitFor();
      const last = callsOf(app.server, "config.set").at(-1)!.params as { ifRevision: string };
      assert.equal(last.ifRevision, `r${w.revision - 1}`);
      assert.equal(w.agents["research-bot"]?.displayName, "Research Bot");
    });
  });
  test("forbidden and unavailable writes show their own message", async () => {
    await withApp({}, async (app) => {
      await open(app); await toReview(app);
      app.server.rpc.scenario("config.set", "forbidden");
      await submit(app);
      await app.page.getByRole("alert").getByText("Your role does not allow creating agents.").waitFor();
      app.server.rpc.scenario("config.set", "unavailable");
      await submit(app);
      await app.page.getByRole("alert").getByText(/configuration service is not available/).waitFor();
    });
  });
});
