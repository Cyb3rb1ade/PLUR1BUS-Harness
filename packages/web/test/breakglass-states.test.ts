// Break-Glass page (`/breakglass`): the contract of a security-relevant control. Who sees the trigger at all, what stands between a
// click and `breakglass.request` (target, reason of 10 to 500 trimmed characters, a window of 1 to 60 minutes, an explicit
// confirmation), one request per double click, a visible countdown and expiry, confirmed revocation, error states, axe.
// Everything runs against test/mock-rpc.ts; the mock's request handler enforces the bounds of rpc.schema.json, so a page that
// sent something outside them would see an E_INVALID_PARAMS. Time is Playwright's fake clock, never a real sleep.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import type { Locator } from "playwright";
import { rpcError, type MockErrorCode } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const MIN = 60_000;
const REASON = "Critical bug triage: investigating memory leak in worker processes";

type Grant = { id: string; holderUserId: string; targetUserId: string; reason: string; issuedAt: number; expiresAt: number };

let counter = 0;
function grant(over: Partial<Grant> = {}): Grant {
  counter += 1;
  return { id: `bg-grant-${counter}`, holderUserId: "usr_owner", targetUserId: `usr_target_${counter}`, reason: "Production incident debugging with database corruption", issuedAt: Date.now() - 5 * MIN, expiresAt: Date.now() + 25 * MIN, ...over };
}

/** A call that stays in flight until the test lets it go: no timer, so a slow machine cannot change what the test sees. */
function hold(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

type SeedOptions = { request?: boolean; revoke?: boolean; holdRequest?: Promise<void>; holdRevoke?: Promise<void>; holdList?: Promise<void> };
/** Registers the four methods. The request handler checks the params like the schema does (target 1 to 128, reason 10 to 500, window 1 to 60). */
function seed(app: App, initial: Grant[] = [], o: SeedOptions = {}): Grant[] {
  const store = [...initial];
  const rpc = app.server.rpc;
  rpc.handle("breakglass.list", async () => {
    if (o.holdList) await o.holdList;
    return { grants: store.map((g) => ({ ...g })) };
  }, { write: false });
  rpc.handle("breakglass.notices", () => ({ notices: [] }), { write: false });
  if (o.request !== false) {
    rpc.handle("breakglass.request", async (p) => {
      if (o.holdRequest) await o.holdRequest;
      const q = p as { targetUserId?: unknown; reason?: unknown; windowMinutes?: unknown };
      const target = typeof q.targetUserId === "string" && q.targetUserId.length >= 1 && q.targetUserId.length <= 128;
      const reason = typeof q.reason === "string" && q.reason.length <= 500 && q.reason.trim().length >= 10;
      const window = q.windowMinutes === undefined || (typeof q.windowMinutes === "number" && Number.isInteger(q.windowMinutes) && q.windowMinutes >= 1 && q.windowMinutes <= 60);
      if (!target || !reason || !window) throw rpcError("E_INVALID_PARAMS", "params outside the documented bounds");
      const minutes = (q.windowMinutes as number | undefined) ?? 15;
      const g = grant({ targetUserId: q.targetUserId as string, reason: q.reason as string, issuedAt: Date.now(), expiresAt: Date.now() + minutes * MIN });
      store.unshift(g);
      return g;
    });
  }
  if (o.revoke !== false) {
    rpc.handle("breakglass.revoke", async (p) => {
      if (o.holdRevoke) await o.holdRevoke;
      const id = (p as { grantId: string }).grantId;
      const at = store.findIndex((g) => g.id === id);
      if (at >= 0) store.splice(at, 1);
      return { id, revoked: true };
    });
  }
  return store;
}

const sent = (app: App, method: string): { params: Record<string, unknown>; csrf: string | null }[] =>
  app.server.rpc.calls.filter((c) => c.method === method) as never;
const anyBreakglass = (app: App): number => app.server.rpc.calls.filter((c) => c.method.startsWith("breakglass.")).length;

const trigger = (app: App) => app.page.getByRole("button", { name: "Request break-glass", exact: true });
const heading = (app: App) => app.page.getByRole("heading", { name: "Break-Glass", level: 1 });

async function openPage(app: App, hash = "#/breakglass"): Promise<void> {
  await openRoute(app.page, hash);
  await heading(app).waitFor();
  await app.page.getByRole("tab", { name: /Active windows/ }).waitFor();
}

async function openDialog(app: App) {
  await trigger(app).click();
  const dialog = app.page.getByRole("dialog", { name: "Request break-glass access" });
  await dialog.waitFor();
  return dialog;
}

type Form = { target?: string; reason?: string; confirm?: boolean };
async function fillForm(dialog: Locator, f: Form): Promise<void> {
  if (f.target !== undefined) await dialog.locator("#bg-target-user").fill(f.target);
  if (f.reason !== undefined) await dialog.locator("#bg-reason").fill(f.reason);
  if (f.confirm !== undefined) await dialog.locator("#bg-confirm-check").setChecked(f.confirm);
}

describe("break-glass: who sees the trigger", opts, () => {
  for (const role of ["viewer", "member", "operator"]) {
    test(`role ${role}: forbidden state, no trigger, no break-glass call at all`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app, [grant()]);
        await openRoute(app.page, "#/breakglass");
        await app.page.locator(".page-state[data-state=forbidden]").waitFor();
        assert.equal(await trigger(app).count(), 0);
        assert.equal(await app.page.locator(".bg-banner").count(), 0);
        assert.equal(await app.page.getByRole("dialog").count(), 0);
        assert.equal(anyBreakglass(app), 0, "a person without the right does not even ask for the list");
      });
    });
  }

  // docs/rbac.md and the guard: Owner and Admin only, people only. A role this UI does not know (an agent, a future preset) gets no trigger.
  for (const role of ["agent", "auditor"]) {
    test(`unknown role ${role}: fails closed, no trigger, no break-glass call`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app, [grant()]);
        await openRoute(app.page, "#/breakglass");
        await app.page.locator(".page-state[data-state=forbidden]").waitFor();
        assert.equal(await trigger(app).count(), 0);
        assert.equal(anyBreakglass(app), 0);
      });
    });
  }

  for (const role of ["owner", "admin"]) {
    test(`role ${role}: trigger is there and opens the dialog without sending anything`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app);
        await openPage(app);
        await openDialog(app);
        assert.equal(sent(app, "breakglass.request").length, 0);
      });
    });
  }

  test("an owner whose list is refused by the server loses the trigger too (forbidden, loading and failed states offer none)", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      seed(app, [], { holdList: gate.promise });
      await openRoute(app.page, "#/breakglass");
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      assert.equal(await trigger(app).count(), 0, "no trigger while loading");
      gate.release();
      await trigger(app).waitFor();
      app.server.rpc.scenario("breakglass.list", "forbidden");
      await app.page.evaluate(() => { location.hash = "#/doctor"; });
      await app.page.evaluate(() => { location.hash = "#/breakglass"; });
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
      assert.equal(await trigger(app).count(), 0);
      app.server.rpc.scenario("breakglass.list", "error");
      await app.page.evaluate(() => { location.hash = "#/doctor"; });
      await app.page.evaluate(() => { location.hash = "#/breakglass"; });
      await app.page.locator(".page-state[data-state=error]").waitFor();
      assert.equal(await trigger(app).count(), 0);
      app.server.rpc.scenario("breakglass.list", "unavailable");
      await app.page.evaluate(() => { location.hash = "#/doctor"; });
      await app.page.evaluate(() => { location.hash = "#/breakglass"; });
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
      assert.equal(await trigger(app).count(), 0);
      assert.equal(sent(app, "breakglass.request").length, 0);
    });
  });

  test("failed list: Try again reloads and the trigger comes back", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("breakglass.list", "error");
      await openRoute(app.page, "#/breakglass");
      await app.page.getByRole("alert").getByRole("heading", { name: "Something went wrong" }).waitFor();
      app.server.rpc.scenario("breakglass.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await trigger(app).waitFor();
    });
  });
});

describe("break-glass: nothing is sent without target, reason and confirmation", opts, () => {
  test("no deep link, query or sub-route opens the dialog or sends a request", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app, `#/breakglass/request?targetUserId=usr_x&reason=${"a".repeat(20)}&windowMinutes=5&confirm=1&confirmed=true`);
      assert.equal(await app.page.getByRole("dialog").count(), 0);
      assert.equal(sent(app, "breakglass.request").length, 0);
      assert.equal(await app.page.locator(".bg-banner").count(), 0);
    });
  });

  test("a valid form with the confirmation box unchecked sends nothing, by click and by Enter, and says why", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      const dialog = await openDialog(app);
      await fillForm(dialog, { target: "usr_incident", reason: REASON, confirm: false });
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.getByText("You must confirm this request before submitting.").waitFor();
      assert.equal(sent(app, "breakglass.request").length, 0);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });

      const again = await openDialog(app);
      await fillForm(again, { target: "usr_incident", reason: REASON });
      await again.locator("#bg-target-user").press("Enter");
      await again.getByText("You must confirm this request before submitting.").waitFor();
      assert.equal(sent(app, "breakglass.request").length, 0, "Enter in a field does not skip the confirmation");
    });
  });

  test("a missing target, a missing reason and a missing confirmation each block the request with their own text", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      const dialog = await openDialog(app);
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.getByText("Target user is required.").waitFor();
      await dialog.getByText("The reason must be at least 10 characters long.").waitFor();
      await dialog.getByText("You must confirm this request before submitting.").waitFor();
      assert.equal(await dialog.locator("#bg-target-user").getAttribute("aria-invalid"), "true");
      assert.equal(await dialog.locator("#bg-reason").getAttribute("aria-invalid"), "true");
      // Whitespace is not a target either.
      await fillForm(dialog, { target: "   ", reason: REASON, confirm: true });
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.getByText("Target user is required.").waitFor();
      assert.equal(sent(app, "breakglass.request").length, 0);
    });
  });

  test("the confirmation is never pre-ticked, and nothing typed survives closing the dialog (Esc or Cancel)", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      for (const close of ["Escape", "Cancel"] as const) {
        const dialog = await openDialog(app);
        assert.equal(await dialog.locator("#bg-confirm-check").isChecked(), false, "starts unticked");
        await fillForm(dialog, { target: "usr_incident", reason: REASON, confirm: true });
        if (close === "Escape") await app.page.keyboard.press("Escape");
        else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        assert.equal(sent(app, "breakglass.request").length, 0);
      }
      const fresh = await openDialog(app);
      assert.equal(await fresh.locator("#bg-target-user").inputValue(), "");
      assert.equal(await fresh.locator("#bg-reason").inputValue(), "");
      assert.equal(await fresh.locator("#bg-confirm-check").isChecked(), false);
    });
  });

  test("the confirmation says what is being confirmed: logged, the person is told, nothing is sent from the label alone", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      const dialog = await openDialog(app);
      const label = (await dialog.locator("label[for=bg-confirm-check]").textContent()) ?? "";
      assert.match(label, /logged/i);
      assert.match(label, /notified/i);
      assert.match((await dialog.textContent()) ?? "", /audited/i);
      assert.equal(await dialog.getByRole("checkbox", { name: label.trim() }).count(), 1, "the box is named by that sentence");
    });
  });

  test("the request is a write: it carries a one-time CSRF token, and its text is only in the POST body", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      const dialog = await openDialog(app);
      await fillForm(dialog, { target: "usr_incident", reason: REASON, confirm: true });
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.waitFor({ state: "hidden" });
      const calls = sent(app, "breakglass.request");
      assert.equal(calls.length, 1);
      assert.ok(calls[0]!.csrf, "csrf header present");
      assert.deepEqual(calls[0]!.params, { targetUserId: "usr_incident", reason: REASON, windowMinutes: 15 });
      for (const r of app.server.requests) {
        assert.ok(!r.url.includes("usr_incident") && !r.url.includes("memory"), `no request URL carries the target or the reason: ${r.url}`);
        if (r.method === "GET") assert.ok(!r.body.includes(REASON));
      }
    });
  });
});

describe("break-glass: reason and window bounds", opts, () => {
  const short = "The reason must be at least 10 characters long.";
  const long = "The reason cannot exceed 500 characters.";

  test("a reason under 10 or over 500 trimmed characters is refused in the dialog, with the matching text", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      const dialog = await openDialog(app);
      const reason = dialog.locator("#bg-reason");
      const refuse = async (text: string, message: string): Promise<void> => {
        await fillForm(dialog, { target: "usr_incident", reason: text, confirm: true });
        await dialog.getByRole("button", { name: "Request access" }).click();
        await dialog.getByText(message, { exact: true }).waitFor();
        assert.equal(await reason.getAttribute("aria-invalid"), "true");
        assert.equal(sent(app, "breakglass.request").length, 0, `refused: ${JSON.stringify(text.slice(0, 12))} (${text.length} chars)`);
      };
      await refuse("", short);
      await refuse("a".repeat(9), short);
      await refuse(`     ${"b".repeat(9)}     `, short);
      await refuse(" ".repeat(40), short);
      await refuse("c".repeat(501), long);
      await refuse(`  ${"d".repeat(501)}  `, long);
    });
  });

  test("exactly 10 and exactly 500 trimmed characters go through, trimmed, and nothing outside the schema is ever sent", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      const accept = async (text: string): Promise<void> => {
        const dialog = await openDialog(app);
        await fillForm(dialog, { target: "usr_incident", reason: text, confirm: true });
        await dialog.getByRole("button", { name: "Request access" }).click();
        await dialog.waitFor({ state: "hidden" });
      };
      await accept("e".repeat(10));
      await accept(`  ${"f".repeat(10)}\n`);
      await accept("g".repeat(500));
      await accept(` ${"h".repeat(500)} `);
      const calls = sent(app, "breakglass.request");
      assert.deepEqual(calls.map((c) => (c.params.reason as string).length), [10, 10, 500, 500]);
      for (const c of calls) assert.equal(c.params.reason, (c.params.reason as string).trim());
      assert.equal(await app.page.locator(".bg-banner-item").count(), 4);
    });
  });

  test("the reason limits are stated in the dialog", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      const dialog = await openDialog(app);
      assert.match((await dialog.textContent()) ?? "", /10 to 500 characters/);
    });
  });

  test("the window is a closed list of whole minutes from 1 to 60, 15 by default; the ends are sent as chosen", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      let dialog = await openDialog(app);
      const values = await dialog.locator("#bg-window option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      assert.ok(values.length >= 2);
      for (const v of values) {
        const n = Number(v);
        assert.ok(Number.isInteger(n) && n >= 1 && n <= 60, `window option ${v} is a whole number of minutes in 1..60`);
      }
      assert.ok(values.includes("1") && values.includes("60"));
      assert.equal(await dialog.locator("#bg-window").inputValue(), "15");
      assert.equal(await dialog.locator("input[type=number], input[name*=window i], input[id*=window i]").count(), 0, "no free-text window");
      for (const minutes of ["1", "60"]) {
        dialog = app.page.getByRole("dialog", { name: "Request break-glass access" });
        if ((await dialog.count()) === 0) dialog = await openDialog(app);
        await dialog.locator("#bg-window").selectOption(minutes);
        await fillForm(dialog, { target: "usr_incident", reason: REASON, confirm: true });
        await dialog.getByRole("button", { name: "Request access" }).click();
        await dialog.waitFor({ state: "hidden" });
      }
      assert.deepEqual(sent(app, "breakglass.request").map((c) => c.params.windowMinutes), [1, 60]);
    });
  });
});

describe("break-glass: one click, one request", opts, () => {
  async function ready(app: App, gate: { promise: Promise<void> }) {
    seed(app, [], { holdRequest: gate.promise });
    await openPage(app);
    const dialog = await openDialog(app);
    await fillForm(dialog, { target: "usr_incident", reason: REASON, confirm: true });
    return dialog;
  }

  test("a double click on Request access sends exactly one breakglass.request and shows one window", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      const dialog = await ready(app, gate);
      await dialog.getByRole("button", { name: "Request access" }).dblclick();
      gate.release();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(sent(app, "breakglass.request").length, 1);
      await app.page.locator(".bg-banner-item").first().waitFor();
      assert.equal(await app.page.locator(".bg-banner-item").count(), 1);
    });
  });

  test("Enter pressed twice in a field sends exactly one request", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      const dialog = await ready(app, gate);
      const target = dialog.locator("#bg-target-user");
      await target.press("Enter");
      await target.press("Enter");
      gate.release();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(sent(app, "breakglass.request").length, 1);
    });
  });

  test("two submits in the same task (a script, an assistive tool) still send exactly one request", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      const dialog = await ready(app, gate);
      await app.page.evaluate(() => {
        const f = document.getElementById("bg-request-form") as HTMLFormElement;
        f.requestSubmit();
        f.requestSubmit();
      });
      gate.release();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(sent(app, "breakglass.request").length, 1);
    });
  });

  test("a double click on the page's own trigger sends nothing and leaves at most one dialog", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      await trigger(app).dblclick();
      await app.page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => { r(null); }); }));
      assert.ok((await app.page.getByRole("dialog").count()) <= 1);
      assert.equal(sent(app, "breakglass.request").length, 0);
    });
  });

  test("while the request is in flight the button says so and is disabled", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      const dialog = await ready(app, gate);
      await dialog.getByRole("button", { name: "Request access" }).click();
      const busy = dialog.getByRole("button", { name: "Requesting access…" });
      await busy.waitFor();
      assert.equal(await busy.isDisabled(), true);
      gate.release();
      await dialog.waitFor({ state: "hidden" });
    });
  });
});

describe("break-glass: the server says no", opts, () => {
  const cases: { name: string; code: MockErrorCode; message: string; text: string }[] = [
    { name: "denied", code: "E_DENIED", message: "no", text: "You do not have permission to perform this break-glass action." },
    { name: "service not available", code: "E_NOT_AVAILABLE", message: "off", text: "The break-glass service is currently unavailable." },
    { name: "internal error", code: "E_INTERNAL", message: "boom", text: "Failed to complete request: boom" },
    { name: "rejected params", code: "E_INVALID_PARAMS", message: "reason too short", text: "Failed to complete request: reason too short" },
  ];
  for (const c of cases) {
    test(`${c.name}: said in the dialog, no window appears, the form is kept for a retry`, async () => {
      await withApp({}, async (app) => {
        seed(app);
        await openPage(app);
        app.server.rpc.handle("breakglass.request", () => { throw rpcError(c.code, c.message); });
        const dialog = await openDialog(app);
        await fillForm(dialog, { target: "usr_incident", reason: REASON, confirm: true });
        await dialog.getByRole("button", { name: "Request access" }).click();
        await dialog.getByRole("alert").getByText(c.text, { exact: true }).waitFor();
        assert.equal(sent(app, "breakglass.request").length, 1);
        assert.equal(await app.page.locator(".bg-banner").count(), 0, "a refused request leaves no window behind");
        assert.equal(await dialog.locator("#bg-reason").inputValue(), REASON);
        assert.equal(await dialog.getByRole("button", { name: "Request access" }).isDisabled(), false, "the user can try again");
      });
    });
  }

  test("a method the core does not serve (-32601) reads as unavailable", async () => {
    await withApp({}, async (app) => {
      seed(app, [], { request: false });
      await openPage(app);
      const dialog = await openDialog(app);
      await fillForm(dialog, { target: "usr_incident", reason: REASON, confirm: true });
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.getByText("The break-glass service is currently unavailable.").waitFor();
      assert.equal(await app.page.locator(".bg-banner").count(), 0);
    });
  });

  test("after a refusal, one retry sends one more request and the window appears", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openPage(app);
      app.server.rpc.handle("breakglass.request", () => { throw rpcError("E_INTERNAL", "boom"); });
      const dialog = await openDialog(app);
      await fillForm(dialog, { target: "usr_incident", reason: REASON, confirm: true });
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.getByRole("alert").getByText("Failed to complete request: boom").waitFor();
      seed(app, [], { revoke: false });
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(sent(app, "breakglass.request").length, 2);
      await app.page.locator(".bg-banner-item").first().waitFor();
    });
  });
});

describe("break-glass: a running window shows its time, and its end", opts, () => {
  test("remaining time in the banner and in the table counts down", async () => {
    await withApp({}, async (app) => {
      seed(app, [grant({ targetUserId: "usr_running", expiresAt: Date.now() + 30 * MIN })]);
      await app.page.clock.install();
      await openRoute(app.page, "#/breakglass");
      const banner = app.page.locator(".bg-banner[role=alert]");
      await banner.getByText(/Remaining time: 29m \d{2}s/).waitFor();
      await banner.getByText("usr_running").waitFor();
      const cell = app.page.locator(".bg-table[aria-label='Active windows'] .bg-banner-timer");
      assert.match((await cell.textContent()) ?? "", /^29m \d{2}s$/);
      await app.page.clock.fastForward(10 * MIN);
      await banner.getByText(/Remaining time: 19m \d{2}s/).waitFor();
      assert.match((await cell.textContent()) ?? "", /^19m \d{2}s$/);
    });
  });

  test("at the end the window leaves the active list and the banner, and is listed as expired", async () => {
    await withApp({}, async (app) => {
      seed(app, [grant({ targetUserId: "usr_ending", expiresAt: Date.now() + 90_000 })]);
      await app.page.clock.install();
      await openRoute(app.page, "#/breakglass");
      const banner = app.page.locator(".bg-banner[role=alert]");
      await banner.getByText(/Remaining time: 1m \d{2}s/).waitFor();
      await app.page.clock.fastForward(2 * MIN);
      await banner.waitFor({ state: "detached" });
      await app.page.getByText("No active break-glass windows.").waitFor();
      await app.page.getByRole("tab", { name: /Past windows \(1\)/ }).click();
      const past = app.page.locator(".bg-table[aria-label='Past windows']");
      await past.getByText("usr_ending").waitFor();
      await past.getByText("Expired", { exact: true }).waitFor();
      assert.equal(await past.getByRole("button").count(), 0, "an ended window cannot be revoked");
    });
  });

  test("a window the server still lists after its end is shown as past, never as active", async () => {
    await withApp({}, async (app) => {
      seed(app, [grant({ targetUserId: "usr_stale", issuedAt: Date.now() - 2 * 60 * MIN, expiresAt: Date.now() - MIN })]);
      await openPage(app);
      assert.equal(await app.page.locator(".bg-banner").count(), 0);
      await app.page.getByText("No active break-glass windows.").waitFor();
      await app.page.getByRole("tab", { name: /Past windows \(1\)/ }).click();
      await app.page.locator(".bg-table[aria-label='Past windows']").getByText("usr_stale").waitFor();
    });
  });
});

describe("break-glass: ending a window needs a confirmation", opts, () => {
  const open = async (app: App, g: Grant, o: SeedOptions = {}) => {
    seed(app, [g], o);
    await openPage(app);
    return app.page.locator(".bg-banner[role=alert]");
  };

  test("banner and table both ask first; Keep active, Esc and the close button end nothing", async () => {
    await withApp({}, async (app) => {
      const g = grant({ targetUserId: "usr_running" });
      const banner = await open(app, g);
      const table = app.page.locator(".bg-table[aria-label='Active windows']");
      for (const button of [banner.getByRole("button", { name: "Revoke now" }), table.getByRole("button", { name: "Revoke now" })]) {
        for (const how of ["keep", "escape", "close"] as const) {
          await button.click();
          const dialog = app.page.getByRole("dialog", { name: "Revoke break-glass window" });
          await dialog.getByText("Are you sure you want to revoke this break-glass window for usr_running? Access will end immediately.").waitFor();
          assert.equal(sent(app, "breakglass.revoke").length, 0, "nothing is sent before the confirmation");
          if (how === "keep") await dialog.getByRole("button", { name: "Keep active" }).click();
          else if (how === "escape") await app.page.keyboard.press("Escape");
          else await dialog.getByRole("button", { name: "Close" }).click();
          await dialog.waitFor({ state: "hidden" });
          assert.equal(sent(app, "breakglass.revoke").length, 0);
          assert.equal(await banner.count(), 1, "the window is still running");
        }
      }
    });
  });

  test("Revoke window sends one breakglass.revoke with the grant id and a CSRF token, and the window ends", async () => {
    await withApp({}, async (app) => {
      const g = grant({ targetUserId: "usr_running" });
      const banner = await open(app, g);
      await banner.getByRole("button", { name: "Revoke now" }).click();
      const dialog = app.page.getByRole("dialog", { name: "Revoke break-glass window" });
      await dialog.getByRole("button", { name: "Revoke window" }).click();
      await dialog.waitFor({ state: "hidden" });
      const calls = sent(app, "breakglass.revoke");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.params, { grantId: g.id });
      assert.ok(calls[0]!.csrf);
      await banner.waitFor({ state: "detached" });
      await app.page.getByText("No active break-glass windows.").waitFor();
    });
  });

  test("a double click on Revoke window revokes once", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      const banner = await open(app, grant(), { holdRevoke: gate.promise });
      await banner.getByRole("button", { name: "Revoke now" }).click();
      const dialog = app.page.getByRole("dialog", { name: "Revoke break-glass window" });
      await dialog.getByRole("button", { name: "Revoke window" }).dblclick();
      gate.release();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(sent(app, "breakglass.revoke").length, 1);
    });
  });

  test("a refused revoke is said in the dialog and the window keeps running", async () => {
    await withApp({}, async (app) => {
      const banner = await open(app, grant({ targetUserId: "usr_running" }));
      app.server.rpc.handle("breakglass.revoke", () => { throw rpcError("E_INTERNAL", "boom"); });
      await banner.getByRole("button", { name: "Revoke now" }).click();
      const dialog = app.page.getByRole("dialog", { name: "Revoke break-glass window" });
      await dialog.getByRole("button", { name: "Revoke window" }).click();
      await dialog.getByRole("alert").getByText("Failed to complete request: boom").waitFor();
      assert.equal(await banner.count(), 1);
      assert.equal(await app.page.getByRole("tab", { name: /Active windows \(1\)/ }).count(), 1);
    });
  });
});

describe("break-glass: the reason stays out of storage and logs", opts, () => {
  test("after a request the reason is in no URL, storage, cookie visible to script or console line", async () => {
    await withApp({}, async (app) => {
      const logged: string[] = [];
      app.page.on("console", (m) => { logged.push(m.text()); });
      seed(app);
      await openPage(app);
      const secret = "Customer escalation INC-48213 payment data inspection";
      const dialog = await openDialog(app);
      await fillForm(dialog, { target: "usr_incident", reason: secret, confirm: true });
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.waitFor({ state: "hidden" });
      await app.page.locator(".bg-banner-item").first().waitFor();
      assert.ok(!app.page.url().includes("INC-48213"));
      const stored = await app.page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
      assert.ok(!stored.includes("INC-48213"), "no storage holds the reason");
      assert.ok(!logged.some((l) => l.includes("INC-48213")), "the console never sees the reason");
      assert.deepEqual(app.problems, []);
    });
  });
});

describe("break-glass: axe and German", opts, () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 400]] as const) {
    test(`axe: page with a running window, all tabs (${scheme}, ${width} px)`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        seed(app, [grant({ targetUserId: "usr_running" }), grant({ targetUserId: "usr_past", expiresAt: Date.now() - MIN })]);
        await openPage(app);
        await app.page.locator(".bg-banner[role=alert]").waitFor();
        await expectAxeClean(app.page, "active tab with banner");
        await app.page.getByRole("tab", { name: /Past windows/ }).click();
        await expectAxeClean(app.page, "past tab");
        await app.page.getByRole("tab", { name: /Received notices/ }).click();
        await expectAxeClean(app.page, "notices tab");
      });
    });
  }

  test("axe: request dialog empty, with every validation error showing, and the revoke dialog", async () => {
    await withApp({}, async (app) => {
      seed(app, [grant({ targetUserId: "usr_running" })]);
      await openPage(app);
      const dialog = await openDialog(app);
      await expectAxeClean(app.page, "request dialog");
      await dialog.getByRole("button", { name: "Request access" }).click();
      await dialog.getByText("You must confirm this request before submitting.").waitFor();
      await expectAxeClean(app.page, "request dialog with errors");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await app.page.locator(".bg-banner").getByRole("button", { name: "Revoke now" }).click();
      await app.page.getByRole("dialog", { name: "Revoke break-glass window" }).waitFor();
      await expectAxeClean(app.page, "revoke dialog");
    });
  });

  test("axe: forbidden, loading, error and empty states", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seed(app);
      await openRoute(app.page, "#/breakglass");
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
      await expectAxeClean(app.page, "forbidden");
    });
    for (const state of ["loading", "error", "empty"] as const) {
      await withApp({}, async (app) => {
        seed(app, [], state === "loading" ? { holdList: hold().promise } : {});
        if (state === "error") app.server.rpc.scenario("breakglass.list", "error");
        await openRoute(app.page, "#/breakglass");
        if (state === "empty") await app.page.getByText("No active break-glass windows.").waitFor();
        else await app.page.locator(`.page-state[data-state=${state}]`).waitFor();
        await expectAxeClean(app.page, state);
      });
    }
  });

  test("German: the confirmation, the bounds and the errors read in German and pass axe", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app, [grant({ targetUserId: "usr_running" })]);
      await openRoute(app.page, "#/breakglass", "de");
      await app.page.getByRole("button", { name: "Break-Glass anfordern", exact: true }).click();
      const dialog = app.page.getByRole("dialog", { name: "Break-Glass-Zugriff anfordern" });
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Zugriff anfordern" }).click();
      await dialog.getByText("Sie müssen die Anforderung vor dem Absenden bestätigen.").waitFor();
      await dialog.getByText("Die Begründung muss mindestens 10 Zeichen lang sein.").waitFor();
      assert.match((await dialog.textContent()) ?? "", /10 bis 500 Zeichen/);
      assert.equal(sent(app, "breakglass.request").length, 0);
      await expectAxeClean(app.page, "request dialog de");
      await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    });
  });
});
