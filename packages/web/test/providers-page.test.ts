// Settings > Providers: credentials list, OAuth sign-in flow (auth.login.*), API key modal,
// logout (auth.logout), role visibility, headless hints, no tokens in DOM, a11y, German.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { sampleCredential, seedProviders } from "./providers-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const open = async (app: App, lang: "en" | "de" = "en"): Promise<void> => {
  await openRoute(app.page, "#/settings/providers", lang);
};
const calls = (app: App, method: string): { params: unknown; csrf: string | null }[] =>
  app.server.rpc.calls.filter((c) => c.method === method);

describe("providers: states", opts, () => {
  test("loading, then lists credentials with provider, route, workspace, status, never a token", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc);
      app.server.rpc.setDelay("auth.credentials.list", 200);
      await open(app);
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      await app.page.getByRole("row", { name: /openai/i }).waitFor();
      await app.page.getByText("ws_default").waitFor();
      await app.page.getByText("ChatGPT-Plan").first().waitFor();

      // Ensure no tokens or secrets are rendered in the DOM
      const content = await app.page.content();
      assert.ok(!content.includes("access_token"));
      assert.ok(!content.includes("refresh_token"));
      assert.ok(!content.includes("client_secret"));
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });

  test("empty state shows guidance and action buttons", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc, []);
      await open(app);
      await app.page.getByRole("heading", { name: /No providers connected yet/i }).waitFor();
      await app.page.getByRole("button", { name: /Sign in/i }).waitFor();
      await app.page.getByRole("button", { name: /Store API key/i }).waitFor();
    });
  });

  test("error offers Try again, which reloads", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc);
      app.server.rpc.scenario("auth.credentials.list", "error", { code: "E_INTERNAL" });
      await open(app);
      await app.page.getByRole("alert").waitFor();
      app.server.rpc.scenario("auth.credentials.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await app.page.getByRole("row", { name: /openai/i }).waitFor();
    });
  });

  test("unavailable when auth.credentials.list is not served", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc);
      app.server.rpc.scenario("auth.credentials.list", "unavailable");
      await open(app);
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
    });
  });

  test("forbidden for operator and viewer: nothing is requested from auth.*", async () => {
    for (const role of ["operator", "viewer"]) {
      await withApp({ server: { role } }, async (app) => {
        seedProviders(app.server.rpc);
        await open(app);
        await app.page.locator(".page-state[data-state=forbidden]").waitFor();
        assert.equal(calls(app, "auth.credentials.list").length, 0);
      });
    }
  });

  test("a server refusal shows forbidden", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc);
      app.server.rpc.scenario("auth.credentials.list", "forbidden");
      await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });
  });
});

describe("providers: OAuth login flow", opts, () => {
  test("Anmelden starts login, displays authorize link, waits and completes", async () => {
    await withApp({}, async (app) => {
      const state = seedProviders(app.server.rpc, []);
      await open(app);

      await app.page.getByRole("button", { name: /Sign in/i }).first().click();
      const dlg = app.page.getByRole("dialog", { name: /Sign in with provider/i });
      await dlg.waitFor();

      // Check headless forwarding hint is rendered
      await dlg.getByText(/ssh -L 49152:127.0.0.1:49152/i).waitFor();

      // Check external authorize link is present
      const link = dlg.getByRole("link", { name: /Open authorization page/i });
      assert.ok(link);
      assert.match((await link.getAttribute("href")) ?? "", /https:\/\/auth\.openai\.com/);

      // Verify auth.login.start call
      const startCalls = calls(app, "auth.login.start");
      assert.equal(startCalls.length, 1);
      assert.deepEqual(startCalls[0]!.params, { provider: "openai" });

      // Click complete / await finishes and updates list
      await dlg.getByRole("button", { name: /Check status|Done/i }).click();
      await app.page.getByRole("row", { name: /openai/i }).waitFor();
      assert.ok(calls(app, "auth.login.await").length >= 1);
    });
  });

  test("Anmelden can be cancelled", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc, []);
      await open(app);

      await app.page.getByRole("button", { name: /Sign in/i }).first().click();
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      await dlg.getByText(/ssh -L/i).waitFor();

      await dlg.getByRole("button", { name: /Cancel/i }).click();
      await dlg.waitFor({ state: "detached" });
      assert.ok(calls(app, "auth.login.cancel").length >= 1);
    });
  });

  test("await errors are explained clearly: login-timeout", async () => {
    await withApp({}, async (app) => {
      const state = seedProviders(app.server.rpc, []);
      state.awaitHandler = () => {
        throw rpcError("E_CONFLICT", "login-timeout", "login-timeout");
      };
      await open(app);

      await app.page.getByRole("button", { name: /Sign in/i }).first().click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByRole("button", { name: /Check status|Done/i }).click();
      await dlg.getByText(/Login timed out/i).waitFor();
    });
  });

  test("callback URL can be pasted manually", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc, []);
      await open(app);

      await app.page.getByRole("button", { name: /Sign in/i }).first().click();
      const dlg = app.page.getByRole("dialog");
      const input = dlg.getByLabel(/Paste callback URL/i);
      await input.fill("http://127.0.0.1:49152/auth/callback?code=abc&state=xyz");
      await dlg.getByRole("button", { name: /Submit callback/i }).click();
      await dlg.getByRole("status").waitFor();

      const cbCalls = calls(app, "auth.login.callback");
      assert.equal(cbCalls.length, 1);
    });
  });
});

describe("providers: API key and logout", opts, () => {
  test("Store API key stores via secret.set without echoing value", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc);
      await open(app);

      await app.page.getByRole("button", { name: /Store API key/i }).click();
      const dlg = app.page.getByRole("dialog", { name: /Store API key/i });
      await dlg.waitFor();

      const secretInput = dlg.getByLabel(/Secret name/i);
      assert.equal(await secretInput.inputValue(), "openai/api-key");

      const keyInput = dlg.getByLabel(/API Key/i);
      assert.equal(await keyInput.getAttribute("type"), "password");
      assert.equal(await keyInput.getAttribute("autocomplete"), "off");
      await keyInput.fill("sk-live-secret-value-1234");

      await dlg.getByRole("button", { name: /Save/i }).click();
      await app.page.getByRole("status").waitFor();

      // Check secret.set was called with exact values
      const setCalls = calls(app, "secret.set");
      assert.equal(setCalls.length, 1);
      assert.deepEqual(setCalls[0]!.params, {
        name: "openai/api-key",
        value: "sk-live-secret-value-1234",
      });

      // Verify value is not in DOM
      const html = await app.page.content();
      assert.ok(!html.includes("sk-live-secret-value-1234"));
    });
  });

  test("logout removes credential after confirmation", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc);
      await open(app);

      await app.page.getByRole("row", { name: /openai/i }).getByRole("button", { name: /Sign out/i }).click();
      const confirm = app.page.getByRole("dialog", { name: /Sign out/i });
      await confirm.waitFor();
      await confirm.getByRole("button", { name: /Sign out|Confirm/i }).click();
      await app.page.getByRole("status").waitFor();

      const logoutCalls = calls(app, "auth.logout");
      assert.equal(logoutCalls.length, 1);
      assert.deepEqual(logoutCalls[0]!.params, {
        id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });
    });
  });
});

describe("providers: keyboard, a11y, German", opts, () => {
  test("axe clean: list, empty, dialogs", async () => {
    await withApp({}, async (app) => {
      seedProviders(app.server.rpc);
      await open(app);
      await expectAxeClean(app.page, "providers list");

      await app.page.getByRole("button", { name: /Sign in/i }).first().click();
      await expectAxeClean(app.page, "providers login dialog");
    });
  });

  test("German translation rendered correctly", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedProviders(app.server.rpc);
      await open(app, "de");
      await app.page.getByRole("heading", { name: /Provider & Anmeldungen/i }).waitFor();
      await app.page.getByRole("button", { name: /Anmelden/i }).first().waitFor();
      await app.page.getByRole("button", { name: /API-Key hinterlegen/i }).waitFor();
    });
  });
});
