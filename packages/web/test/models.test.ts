// Models page (E8): states, catalog, "new" badge + acknowledge, filters, scan, overrides, live update, layout, a11y, keyboard.
// The backend does not serve /rpc or /events yet; everything runs against test/mock-rpc.ts.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError, type MockRpc } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

type Model = Record<string, unknown>;
const M = (o: Model = {}): Model => ({
  provider: "openai", id: "gpt-5", displayName: "GPT-5", kind: "chat", contextWindow: 400000, capabilities: ["tools", "vision"], aliases: ["gpt5"],
  status: "available", firstSeen: "2026-10-03T07:12:44.120Z", lastSeen: "2026-10-03T07:12:44.120Z", source: "scan", overrides: {}, ...o,
});
const key = (m: Model): string => `${String(m.provider)}\u0000${String(m.id)}`;

type Seeded = { models: Model[]; newIds: Set<string>; providers: Model[]; warnings: Model[] };
function seed(rpc: MockRpc, over: Partial<Seeded> = {}): Seeded {
  const s: Seeded = {
    models: [
      M(), M({ id: "gpt-4o", displayName: "GPT-4o", firstSeen: "2026-01-01T00:00:00Z" }),
      M({ id: "gpt-3", displayName: "GPT-3", status: "unavailable" }),
      M({ provider: "anthropic", id: "claude-x", displayName: "Claude X", kind: "unknown", contextWindow: undefined, capabilities: [], aliases: [], apiKey: "sk-live-SECRET-1", note: "visible-note" }),
      M({ provider: "local", id: "my/llama:8b", displayName: "My Llama", source: "manual", status: "manual", overrides: { displayName: "My Llama" } }),
    ],
    newIds: new Set([key(M())]),
    providers: [{ provider: "openai", lastScanAt: "2026-10-03T07:12:44.120Z", lastResult: "ok" }, { provider: "anthropic", lastResult: "failed:auth", consecutiveFailures: 2 }],
    warnings: [{ code: "role_unavailable", role: "default", provider: "openai", id: "gpt-3" }],
    ...over,
  };
  rpc.handle("models.list", (p) => {
    const only = (p as { newOnly?: boolean } | undefined)?.newOnly === true;
    return { models: only ? s.models.filter((m) => s.newIds.has(key(m))) : s.models, providers: s.providers, newCount: s.newIds.size, warnings: s.warnings };
  }, { write: false });
  rpc.handle("models.acknowledge", () => { s.newIds.clear(); return { acknowledgedAt: "2026-10-07T08:00:00Z" }; });
  rpc.handle("models.scan", () => {
    const fresh = M({ id: "gpt-5-mini", displayName: "GPT-5 mini" });
    s.models.push(fresh); s.newIds.add(key(fresh));
    const base = { reappeared: [], unchanged: 3, duplicates: 0, warnings: [], nextScanAt: null };
    return { startedAt: "2026-10-07T08:00:00Z", finishedAt: "2026-10-07T08:00:02Z", providers: [
      { provider: "openai", result: "ok", new: ["gpt-5", "gpt-5-mini"], unavailable: ["gpt-3"], ...base },
      { provider: "anthropic", result: "failed:auth", new: [], unavailable: [], ...base, error: { code: "auth", reason: "http 401", retryable: false, hint: "renew sign-in" } },
    ] };
  });
  rpc.handle("models.setOverride", (p) => {
    const q = p as { provider: string; id: string; set?: Model; create?: boolean };
    const found = s.models.find((m) => m.provider === q.provider && m.id === q.id);
    if (found) { Object.assign(found, q.set ?? {}); found.overrides = { ...(found.overrides as Model), ...(q.set ?? {}) }; return found; }
    const created = M({ provider: q.provider, id: q.id, displayName: q.id, source: "manual", status: "manual", ...(q.set ?? {}), overrides: q.set ?? {} });
    s.models.push(created); return created;
  });
  rpc.handle("models.removeManual", (p) => {
    const q = p as { provider: string; id: string };
    const n = s.models.length; s.models = s.models.filter((m) => !(m.provider === q.provider && m.id === q.id));
    return { removed: s.models.length < n };
  });
  return s;
}

const open = async (app: App, hash = "#/models"): Promise<void> => { await openRoute(app.page, hash); };
const calls = (app: App, method: string): { params: unknown; csrf: string | null }[] => app.server.rpc.calls.filter((c) => c.method === method);
const link = (page: Page, name: string | RegExp) => page.getByRole("link", { name });

describe("models: states", opts, () => {
  test("loading, then the catalog", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.setDelay("models.list", 300);
      await open(app);
      await app.page.getByRole("heading", { name: "Models", level: 1 }).waitFor();
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      await link(app.page, /GPT-4o/).waitFor();
      assert.equal(await app.page.locator(".page-state").count(), 0);
    });
  });
  test("empty catalog explains and offers a scan", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, { models: [], newIds: new Set(), warnings: [] });
      await open(app);
      await app.page.getByRole("heading", { name: "No models in the catalog yet" }).waitFor();
      await app.page.locator(".page-state").getByRole("button", { name: "Scan providers" }).waitFor();
    });
  });
  test("error with retry, forbidden, unavailable (scenario and route missing)", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.scenario("models.list", "error");
      await open(app);
      await app.page.getByRole("alert").getByRole("heading", { name: "Something went wrong" }).waitFor();
      app.server.rpc.scenario("models.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await link(app.page, /GPT-4o/).waitFor();
      app.server.rpc.scenario("models.list", "forbidden");
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
      app.server.rpc.scenario("models.list", "unavailable");
      await app.page.evaluate(() => { location.hash = "#/doctor"; }); await app.page.evaluate(() => { location.hash = "#/models"; });
      await app.page.getByRole("heading", { name: "Not available" }).waitFor();
    });
    await withApp({}, async (app) => { // /rpc not served at all: 404
      await open(app);
      await app.page.getByRole("heading", { name: "Not available" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Scan providers" }).count(), 0, "no actions on an unavailable backend");
    });
  });
});

describe("models: catalog", opts, () => {
  test("groups by provider, shows status and the new badge only on new models, masks secrets, says 'unknown' for missing metadata", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      for (const p of ["openai", "anthropic", "local"]) await app.page.getByRole("heading", { name: p, level: 2, exact: true }).waitFor();
      const gpt5 = link(app.page, /GPT-5/);
      assert.match((await gpt5.textContent()) ?? "", /new/i);
      assert.doesNotMatch((await link(app.page, /GPT-4o/).textContent()) ?? "", /\bnew\b/i);
      assert.match((await link(app.page, /GPT-3/).textContent()) ?? "", /Unavailable/);
      await link(app.page, /Claude X/).click();
      const detail = app.page.getByRole("region", { name: "Model details" });
      await detail.getByRole("heading", { name: "Claude X", level: 2 }).waitFor();
      const text = (await detail.textContent()) ?? "";
      assert.match(text, /Kind\s*unknown/i); assert.match(text, /Context window\s*unknown/i);
      assert.ok(text.includes("visible-note")); assert.ok(!text.includes("sk-live-SECRET-1")); assert.ok(text.includes("••••"));
      assert.ok(!(await app.page.content()).includes("sk-live-SECRET-1"));
    });
  });
  test("provider scan states and warnings are listed", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const card = app.page.getByRole("group", { name: "Providers" });
      await card.waitFor();
      assert.match((await card.textContent()) ?? "", /anthropic[\s\S]*Sign-in was refused/);
      await app.page.getByText("The model for role default (openai / gpt-3) is unavailable.").waitFor();
    });
  });
  test("the new badge stays until acknowledged; acknowledge clears it and calls models.acknowledge once", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await link(app.page, /GPT-5/).waitFor();
      const ack = app.page.getByRole("button", { name: "Mark 1 new as seen" });
      await ack.click();
      await app.page.getByRole("button", { name: /Mark .* new as seen/ }).waitFor({ state: "detached" });
      assert.doesNotMatch((await link(app.page, /GPT-5/).textContent()) ?? "", /\bnew\b/i);
      assert.equal(calls(app, "models.acknowledge").length, 1);
      assert.ok(calls(app, "models.acknowledge")[0]!.csrf, "a write carries a CSRF token");
    });
  });
  test("filters: provider, status, only new", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await link(app.page, /GPT-4o/).waitFor();
      await app.page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      assert.equal(await link(app.page, /GPT-4o/).count(), 0); await link(app.page, /Claude X/).waitFor();
      await app.page.getByLabel("Provider", { exact: true }).selectOption("");
      await app.page.getByLabel("Status", { exact: true }).selectOption("unavailable");
      await link(app.page, /GPT-3/).waitFor(); assert.equal(await link(app.page, /Claude X/).count(), 0);
      await app.page.getByLabel("Status", { exact: true }).selectOption("");
      await app.page.getByRole("button", { name: "Only new models" }).click();
      await link(app.page, /GPT-5/).waitFor(); assert.equal(await link(app.page, /GPT-4o/).count(), 0);
      await app.page.getByLabel("Provider", { exact: true }).selectOption("local");
      await app.page.getByText("No model matches the filters.").waitFor();
    });
  });
});

describe("models: scan", opts, () => {
  test("shows the running state, then 'N new, M no longer available', failed providers and the usable-at-once note", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.setDelay("models.scan", 400); await open(app);
      await link(app.page, /GPT-4o/).waitFor();
      const btn = app.page.getByRole("button", { name: "Scan providers" });
      await btn.click();
      await app.page.getByRole("status").filter({ hasText: "Scan in progress" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Scanning…" }).getAttribute("aria-disabled"), "true");
      const result = app.page.locator("[data-scan-result]");
      await result.getByText("2 new, 1 no longer available").waitFor();
      assert.match((await result.textContent()) ?? "", /New models can be used right away/);
      assert.match((await result.textContent()) ?? "", /anthropic[\s\S]*Sign-in was refused/);
      await link(app.page, /GPT-5 mini/).waitFor(); // the list was reloaded
      assert.equal(calls(app, "models.scan").length, 1);
      assert.ok(calls(app, "models.scan")[0]!.csrf);
    });
  });
  test("a failing scan call shows an alert and keeps the catalog", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await link(app.page, /GPT-4o/).waitFor();
      app.server.rpc.handle("models.scan", () => { throw rpcError("E_INTERNAL", "boom"); });
      await app.page.getByRole("button", { name: "Scan providers" }).click();
      await app.page.getByRole("alert").getByText("The scan could not be run.").waitFor();
      await link(app.page, /GPT-4o/).waitFor();
      app.server.rpc.handle("models.scan", () => { throw rpcError("E_DENIED", "no", "no-permission"); });
      await app.page.getByRole("button", { name: "Scan providers" }).click();
      await app.page.getByRole("alert").getByText("You are not allowed to scan providers.").waitFor();
    });
  });
});

describe("models: live updates", opts, () => {
  test("models.changed on the event stream reloads the catalog", async () => {
    await withApp({}, async (app) => {
      const s = seed(app.server.rpc); app.server.events.enable(); await open(app);
      await link(app.page, /GPT-4o/).waitFor();
      await app.server.events.waitForConnections(1);
      await app.page.getByText("Live updates are on.").waitFor();
      const fresh = M({ id: "gpt-6", displayName: "GPT-6" }); s.models.push(fresh); s.newIds.add(key(fresh));
      app.server.events.push({ event: "models.changed", data: { provider: "openai", discovered: ["gpt-6"], reappeared: [], unavailable: [], at: "2026-10-07T09:00:00Z" } });
      await link(app.page, /GPT-6/).waitFor();
    });
  });
  test("without an event stream the page says so and Refresh still works", async () => {
    await withApp({}, async (app) => {
      const s = seed(app.server.rpc); await open(app);
      await app.page.getByText("Live updates are not available; use Refresh.").waitFor();
      s.models.push(M({ id: "late", displayName: "Late" }));
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await link(app.page, /Late/).waitFor();
    });
  });
});

describe("models: overrides", opts, () => {
  test("edit dialog validates, saves the override and returns focus; Esc closes", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await link(app.page, /GPT-4o/).click();
      const edit = app.page.getByRole("button", { name: "Edit overrides" });
      await edit.focus(); await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog", { name: "Edit overrides: GPT-4o" });
      await dlg.waitFor();
      await dlg.getByLabel("Context window (tokens)").fill("0");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByText("Enter a whole number of at least 1.").waitFor();
      assert.equal(calls(app, "models.setOverride").length, 0);
      await dlg.getByLabel("Context window (tokens)").fill("128000");
      await dlg.getByLabel("Display name").fill("Four-o");
      await dlg.getByLabel("Aliases (comma separated)").fill("4o, omni");
      await dlg.getByRole("button", { name: "Tools", pressed: false }).click();
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.waitFor({ state: "detached" });
      const c = calls(app, "models.setOverride")[0]!;
      const p = c.params as { provider: string; id: string; set: Record<string, unknown> };
      assert.equal(p.provider, "openai"); assert.equal(p.id, "gpt-4o");
      assert.equal(p.set.contextWindow, 128000); assert.equal(p.set.displayName, "Four-o"); assert.deepEqual(p.set.aliases, ["4o", "omni"]);
      assert.ok(c.csrf);
      await app.page.getByRole("region", { name: "Model details" }).getByRole("heading", { name: "Four-o" }).waitFor();
      assert.equal(await app.page.evaluate(() => document.activeElement?.textContent?.trim()), "Edit overrides");
      await app.page.keyboard.press("Enter");
      await app.page.getByRole("dialog").waitFor();
      await app.page.keyboard.press("Escape");
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
    });
  });
  test("reset all overrides sends clear: all; a forbidden write is explained inside the dialog", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await link(app.page, /My Llama/).click();
      await app.page.getByRole("button", { name: "Edit overrides" }).click();
      app.server.rpc.handle("models.setOverride", () => { throw rpcError("E_DENIED", "no", "no-permission"); });
      await app.page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
      await app.page.getByRole("dialog").getByRole("alert").getByText("You are not allowed to change the catalog.").waitFor();
      app.server.rpc.handle("models.setOverride", (q) => ({ ...M(), ...(q as object) }));
      await app.page.getByRole("button", { name: "Reset all overrides" }).click();
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal((calls(app, "models.setOverride").at(-1)!.params as { clear?: unknown }).clear, "all");
    });
  });
  test("add a manual model; remove a manual model after confirming", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await link(app.page, /GPT-4o/).waitFor();
      await app.page.getByRole("button", { name: "Add manual model" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Add manual model" });
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByText("This field is required.").first().waitFor();
      await dlg.getByLabel("Provider", { exact: true }).fill("local");
      await dlg.getByLabel("Model id").fill("tiny");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.waitFor({ state: "detached" });
      const p = calls(app, "models.setOverride")[0]!.params as { create?: boolean; provider: string; id: string };
      assert.deepEqual([p.create, p.provider, p.id], [true, "local", "tiny"]);
      await link(app.page, /tiny/).click();
      await app.page.getByRole("button", { name: "Remove manual model" }).click();
      const confirm = app.page.getByRole("dialog", { name: "Remove manual model" });
      await confirm.getByText("Remove local / tiny from the catalog?").waitFor();
      await confirm.getByRole("button", { name: "Remove", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.deepEqual(calls(app, "models.removeManual")[0]!.params, { provider: "local", id: "tiny" });
      await app.page.getByText("Select an item to see its details.").or(app.page.getByText("This model is not in the catalog.")).first().waitFor();
    });
  });
  test("scanned models offer no 'remove manual model'", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await link(app.page, /GPT-4o/).click();
      await app.page.getByRole("button", { name: "Edit overrides" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Remove manual model" }).count(), 0);
    });
  });
});

describe("models: layout, a11y, keyboard, language", opts, () => {
  for (const width of [400, 960, 1440, 2560] as const) {
    test(`no horizontal scroll, list then detail (${width} px)`, async () => {
      await withApp({ width, height: 900 }, async (app) => {
        seed(app.server.rpc); await open(app, "#/models");
        await link(app.page, /GPT-4o/).waitFor();
        const scroll = (): Promise<boolean> => app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        assert.equal(await scroll(), false, "list");
        await link(app.page, /Claude X/).click();
        await app.page.getByRole("region", { name: "Model details" }).getByRole("heading", { name: "Claude X" }).waitFor();
        assert.equal(await scroll(), false, "detail");
        const listVisible = await app.page.getByRole("region", { name: "Models" }).isVisible();
        assert.equal(listVisible, width >= 1024, "compact shows the detail OR the list");
        if (width < 1024) {
          await app.page.getByRole("button", { name: "Back to list" }).click();
          await link(app.page, /GPT-4o/).waitFor();
        }
      });
    });
  }
  test("keyboard: Tab reaches a model link, Enter opens its detail, focus moves into the detail region in compact", async () => {
    await withApp({ width: 400, height: 900 }, async (app) => {
      seed(app.server.rpc); await open(app);
      const l = link(app.page, /GPT-4o/); await l.waitFor();
      await l.focus(); await app.page.keyboard.press("Enter");
      await app.page.getByRole("region", { name: "Model details" }).getByRole("heading", { name: "GPT-4o" }).waitFor();
      assert.equal(await app.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Model details");
    });
  });
  for (const [scheme, width] of [["light", 1440], ["dark", 400]] as const) {
    test(`axe: catalog, detail, dialog, scan result (${scheme}, ${width} px)`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        seed(app.server.rpc); await open(app);
        await link(app.page, /GPT-4o/).waitFor();
        await expectAxeClean(app.page, "catalog");
        await link(app.page, /Claude X/).click();
        await app.page.getByRole("region", { name: "Model details" }).getByRole("heading", { name: "Claude X" }).waitFor();
        await expectAxeClean(app.page, "detail");
        await app.page.getByRole("button", { name: "Edit overrides" }).click();
        await app.page.getByRole("dialog").waitFor();
        await expectAxeClean(app.page, "dialog");
        await app.page.keyboard.press("Escape");
        if (width >= 1024) {
          await app.page.getByRole("button", { name: "Scan providers" }).click();
          await app.page.locator("[data-scan-result]").waitFor();
          await expectAxeClean(app.page, "scan result");
        }
      });
    });
  }
  for (const state of ["empty", "error", "forbidden", "unavailable", "loading"] as const) {
    test(`axe: ${state} state`, async () => {
      await withApp({ width: 960, height: 800 }, async (app) => {
        seed(app.server.rpc, state === "empty" ? { models: [], newIds: new Set() } : {});
        if (state === "error" || state === "forbidden" || state === "unavailable") app.server.rpc.scenario("models.list", state);
        if (state === "loading") app.server.rpc.setDelay("models.list", 3000);
        await open(app);
        await app.page.locator(`.page-state[data-state=${state}]`).waitFor();
        await expectAxeClean(app.page, state);
      });
    });
  }
  test("German texts", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app.server.rpc);
      await openRoute(app.page, "#/models", "de");
      await app.page.getByRole("heading", { name: "Modelle", level: 1 }).waitFor();
      await app.page.getByRole("button", { name: "Anbieter scannen" }).click();
      await app.page.getByText("2 neu, 1 nicht mehr verfügbar").waitFor();
      await app.page.getByRole("button", { name: /1 neue? als gesehen markieren|als gesehen markieren/ }).first().waitFor();
    });
  });
});
