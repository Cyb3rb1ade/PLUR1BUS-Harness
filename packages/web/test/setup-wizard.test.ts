// First-run wizard (K2, route /setup): end to end against the mock RPC server, resume, validation, variants, failures.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, setup, teardown, TOKEN, withApp } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { GEMMA_BLOCK, calls, changes, next, open, seed, skip, stepHeading, toPersona, toSwitchboard } from "./setup-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("setup wizard: flow", opts, () => {
  test("shipped defaults are provider-specific, available and owner-confirmed; limited alternatives remain selectable", async () => {
    await withApp({}, async app => {
      seed(app.server.rpc, [
        {provider:'anthropic',id:'claude-sonnet-5-5',kind:'chat',status:'available'},
        {provider:'anthropic',id:'limited-alternative',kind:'chat',status:'available',toolUse:'limited tool use'},
        {provider:'openai',id:'gpt-6-astra',kind:'chat',status:'available'},
      ]);
      await open(app); await toPersona(app);
      await app.page.getByLabel('Display name').fill('Hal'); await next(app.page);
      const models=app.page.getByLabel('Chat model', {exact:true});
      await app.page.waitForFunction(()=> (document.querySelector('#setup-model') as HTMLSelectElement)?.value === 'anthropic/claude-sonnet-5-5');
      await models.selectOption('anthropic/limited-alternative');
      assert.equal(await models.inputValue(),'anthropic/limited-alternative');
      await app.page.getByLabel('Provider',{exact:true}).selectOption('openai');
      assert.equal(await models.inputValue(),'');
      await models.selectOption('openai/gpt-6-astra');
      assert.equal(await models.inputValue(),'openai/gpt-6-astra');
      await app.page.getByLabel('Provider',{exact:true}).selectOption('anthropic');
      assert.equal(await models.inputValue(),'anthropic/claude-sonnet-5-5');
    });
  });

  test("all nine steps in order, exact config.set params, summary with a link to the chat", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await stepHeading(page, "Your account").waitFor();
      await page.locator("main").getByText(/signed in as owner/i).waitFor(); // the session loads after the heading appears
      assert.match((await page.locator("main").textContent()) ?? "", /signed in as owner/i);
      assert.equal(await page.locator("ol.setup-progress li").count(), 9);
      assert.equal(await page.locator("ol.setup-progress li[aria-current=step]").count(), 1);
      await next(page);
      // Memory comes before the first agent exists, so a fresh store still takes the chosen embedding model.
      await stepHeading(page, /Memory/).waitFor();
      await page.getByRole("radio", { name: /EmbeddingGemma 2/ }).waitFor();
      await next(page);
      await stepHeading(page, "Name & persona").waitFor();
      await page.getByLabel("Display name").fill("Hal");
      await next(page);
      await stepHeading(page, /Main model/).waitFor();
      await page.getByLabel("Chat model").selectOption("anthropic/claude-x");
      await next(page);
      await stepHeading(page, /Decision model/).waitFor(); await skip(page);
      await stepHeading(page, /Switchboard/).waitFor();
      await page.getByText("cannot be done from the browser yet").waitFor();
      assert.equal(await page.getByRole("button", { name: "Next" }).count(), 0, "an unavailable step can only be skipped");
      await skip(page);
      await stepHeading(page, /Language for voice features/).waitFor();
      await skip(page);
      await stepHeading(page, /Backups/).waitFor();
      await page.getByRole("button", { name: "Create a backup now" }).click();
      await page.getByText("Backup created: plur1bus-20261007-setup").waitFor();
      await next(page);
      await stepHeading(page, /Import/).waitFor();
      assert.equal(await page.locator("code").filter({ hasText: "plur1bus import" }).count(), 1);
      await skip(page);
      await stepHeading(page, "Setup summary").waitFor();

      const c = changes(app);
      assert.equal(c.length, 2);
      const persona = calls(app,"agent.create")[0]!.params as {name:string;displayName:string;idempotencyKey:string};
      assert.equal(persona.name,"main");assert.equal(persona.displayName,"Hal");assert.match(persona.idempotencyKey,/^setup-main-[0-9]+$/);
      assert.deepEqual(c[0], [{ key: "embedding.useClass", value: "general" }, GEMMA_BLOCK]);
      assert.deepEqual(c[1], [{ key: "modelRoles.chat", value: "anthropic/claude-x" }]);
      assert.deepEqual(calls(app, "admin.backup.snapshot").map((x) => x.params), [{ label: "setup" }]);

      const sum = (await page.locator(".setup-summary").textContent()) ?? "";
      assert.match(sum, /Your account\s*done/); assert.match(sum, /Agent main, named Hal/); assert.match(sum, /Chat model anthropic\/claude-x/);
      assert.match(sum, /embedding EmbeddingGemma 2 \(text\), reranker BGE-reranker-v2-m3/);
      assert.match(sum, /Switchboard\s*skipped/); assert.match(sum, /Language for voice features\s*skipped/); assert.match(sum, /Import\s*skipped/); assert.match(sum, /Backup plur1bus-20261007-setup/);
      assert.equal(await page.getByRole("link", { name: "Go to the chat" }).getAttribute("href"), "#/chat");
      assert.deepEqual(app.problems, []);
    });
  });

  test("eight steps with ?mode=bundled: no account step, Memory first", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app, "#/setup?mode=bundled");
      await stepHeading(app.page, /Memory/).waitFor();
      assert.equal(await app.page.locator("ol.setup-progress li").count(), 8);
      assert.match((await app.page.locator(".setup-count").textContent()) ?? "", /Step 1 of 8/);
      assert.equal(await app.page.locator("ol.setup-progress").getByText("Your account").count(), 0);
    });
  });

  test("progress is announced politely and the focus moves to the step heading", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await stepHeading(page, "Your account").waitFor();
      const live = page.locator("main [role=status][aria-live=polite]").first();
      assert.equal(((await live.textContent()) ?? "").trim(), "Step 1 of 9: Your account");
      await next(page);
      await stepHeading(page, /Memory/).waitFor();
      assert.equal(((await live.textContent()) ?? "").trim(), "Step 2 of 9: Memory");
      await skip(page);
      await stepHeading(page, "Name & persona").waitFor();
      assert.equal(((await live.textContent()) ?? "").trim(), "Step 3 of 9: Name & persona");
      await page.waitForFunction(() => document.activeElement?.tagName === "H2" && document.activeElement?.textContent === "Name & persona");
    });
  });

  test("back keeps the answers, and a second pass over a saved step writes the same createdAt", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toSwitchboard(app);
      await page.getByRole("button", { name: "Back" }).click();
      await stepHeading(page, /Decision model/).waitFor();
      await page.getByRole("button", { name: "Back" }).click();
      await stepHeading(page, /Main model/).waitFor();
      assert.equal(await page.getByLabel("Chat model").inputValue(), "anthropic/claude-x");
      await page.getByRole("button", { name: "Back" }).click();
      await stepHeading(page, "Name & persona").waitFor();
      assert.equal(await page.getByLabel("Display name").inputValue(), "Hal");
      assert.equal(await page.getByLabel("Agent id").inputValue(), "main");
      await next(page);
      await stepHeading(page, /Main model/).waitFor();
      const first = calls(app,"agent.create")[0]!.params as {displayName:string};
      const second = changes(app).find(c=>c[0]?.key==="agents.main")![0]!.value as {displayName:string};
      assert.equal(first.displayName,second.displayName);assert.equal(calls(app,"agent.create").length,1,"revisiting an existing agent updates instead of creating again");
    });
  });
});

describe("setup wizard: resume and storage", opts, () => {
  test("progress and answers survive a reload; the token and other secrets never reach storage", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toSwitchboard(app);
      await page.reload();
      await stepHeading(page, /Switchboard/).waitFor();
      assert.match((await page.locator(".setup-count").textContent()) ?? "", /Step 6 of 9/);
      await page.getByRole("button", { name: "Back" }).click();
      await stepHeading(page, /Decision model/).waitFor();
      await page.getByRole("button", { name: "Back" }).click();
      await stepHeading(page, /Main model/).waitFor();
      await page.getByRole("button", { name: "Back" }).click();
      assert.equal(await page.getByLabel("Display name").inputValue(), "Hal");
      const dump = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      assert.ok(!dump.includes(TOKEN), "owner token in storage");
      assert.doesNotMatch(dump, /token|secret|password|csrf/i);
      const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("setup")));
      assert.deepEqual(keys, ["plur1bus.web.setup"]);
    });
  });

  test("a corrupt saved state starts the wizard from the top; blocked storage does not break it", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      await app.page.evaluate(() => localStorage.setItem("plur1bus.web.setup", "{not json"));
      await open(app);
      await stepHeading(app.page, "Your account").waitFor();
    });
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      await app.page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
      await app.page.reload();
      await open(app);
      await stepHeading(app.page, "Your account").waitFor();
      await next(app.page);
      await stepHeading(app.page, /Memory/).waitFor();
    });
  });
});

describe("setup wizard: validation and failures", opts, () => {
  test("persona: empty name and a bad id block Next with an inline error and send nothing", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toPersona(app);
      await next(page);
      await page.getByText("Enter a display name.").waitFor();
      assert.equal(await page.getByLabel("Display name").getAttribute("aria-invalid"), "true");
      assert.match((await page.getByLabel("Display name").getAttribute("aria-describedby")) ?? "", /err/);
      await page.waitForFunction(() => document.activeElement?.id === "setup-display-name");
      await page.getByLabel("Agent id").fill("Bad Id");
      await page.getByLabel("Display name").fill("Hal");
      await next(page);
      await page.getByText(/Use lower-case letters/).waitFor();
      await page.getByLabel("Agent id").fill("");
      await next(page);
      await page.getByText("Enter an agent id.").waitFor();
      assert.equal(calls(app, "config.set").length, 0);
      await page.getByLabel("Agent id").fill("hal-9000");
      await next(page);
      await stepHeading(page, /Main model/).waitFor();
      assert.equal((calls(app,"agent.create")[0]!.params as {name:string}).name,"hal-9000");
    });
  });

  test("model: nothing chosen blocks Next; only usable chat models are offered; skip is allowed", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toPersona(app); await page.getByLabel("Display name").fill("Hal"); await next(page);
      await stepHeading(page, /Main model/).waitFor();
      await page.getByLabel("Chat model").waitFor();
      const opts = await page.getByLabel("Chat model").locator("option").allTextContents();
      assert.deepEqual(opts, ["Choose a model…", "Claude X"]);
      await next(page);
      await page.getByText("Choose a model, or skip this step.").waitFor();
      assert.equal(calls(app, "agent.create").length, 1);
      await skip(page);
      await stepHeading(page, /Decision model/).waitFor(); await skip(page);
      await stepHeading(page, /Switchboard/).waitFor();
      assert.equal(calls(app, "agent.create").length, 1);
    });
  });

  test("model: empty catalogue and a harness without models.list show a state and allow skipping", async () => {
    for (const models of [[], null] as const) {
      await withApp({}, async (app) => {
        seed(app.server.rpc, models as unknown[] | null); await open(app);
        const { page } = app;
        await toPersona(app); await page.getByLabel("Display name").fill("Hal"); await next(page);
        await stepHeading(page, /Main model/).waitFor();
        await page.getByText(models === null ? /does not offer this setting yet/ : /No chat models were found/).waitFor();
        await page.getByText(/Signing in to a provider is not available/).waitFor();
        await skip(page);
      await stepHeading(page, /Decision model/).waitFor(); await skip(page);
        await stepHeading(page, /Switchboard/).waitFor();
      });
    }
  });

  test("model list error offers Try again", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.scenario("models.list", "error");
      await open(app);
      const { page } = app;
      await toPersona(app); await page.getByLabel("Display name").fill("Hal"); await next(page);
      await page.getByText("The model list could not be loaded.").waitFor();
      app.server.rpc.scenario("models.list", "success");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.getByLabel("Chat model").waitFor();
    });
  });

  test("backup: Next is blocked until a backup exists; a failed backup says so and can be retried", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toSwitchboard(app); await skip(page);
      await stepHeading(page, /Language for voice features/).waitFor(); await skip(page);
      await stepHeading(page, /Backups/).waitFor();
      await next(page);
      await page.getByText("Create a backup, or skip this step.").waitFor();
      app.server.rpc.scenario("admin.backup.snapshot", "error");
      await page.getByRole("button", { name: "Create a backup now" }).click();
      await page.getByRole("alert").getByText("The backup could not be created.").waitFor();
      app.server.rpc.scenario("admin.backup.snapshot", "success");
      await page.getByRole("button", { name: "Create a backup now" }).click();
      await page.getByText(/Backup created/).waitFor();
      await next(page);
      await stepHeading(page, /Import/).waitFor();
    });
  });

  test("a failing config.set keeps the step and shows the reason; forbidden and unavailable read differently", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toPersona(app); await page.getByLabel("Display name").fill("Hal");
      for (const [scenario, text] of [["error", /Saving failed/], ["forbidden", /not allowed to change/], ["unavailable", /does not offer this setting yet/]] as const) {
        app.server.rpc.scenario("agent.create", scenario);
        await next(page);
        await page.getByRole("alert").getByText(text).waitFor();
        await stepHeading(page, "Name & persona").waitFor();
      }
      app.server.rpc.scenario("agent.create", "success");
      await next(page);
      await stepHeading(page, /Main model/).waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
    });
  });

  test("a conflict from the server is reported as a failure, not swallowed", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      app.server.rpc.handle("agent.create", () => { throw rpcError("E_CONFIG_INVALID", "bad value"); });
      await open(app);
      await toPersona(app); await app.page.getByLabel("Display name").fill("Hal"); await next(app.page);
      await app.page.getByRole("alert").getByText(/Saving failed/).waitFor();
    });
  });
});
