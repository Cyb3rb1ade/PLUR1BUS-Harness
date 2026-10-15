// Step 11 (Surfaces: Media and My identities) of the server hardening sweep, against the mock API in a real Chromium (skipped,
// with a reason, where none is found). Already pinned elsewhere (not repeated): success, empty, error and forbidden of the three
// routes, download and deletion bound to a stored id and confirmation, the pairing code existing only in the answer that issues
// it, project traces with redacted previews (surfaces-pages.test.ts), the CLI half against a real core (surfaces-e2e.test.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import type { MockHarnessServer } from "./mock-server.ts";
import { rpcError } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const surfaces = join(fileURLToPath(new URL("..", import.meta.url)), "src/pages/surfaces");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const out = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid(n), agentId: "zeta", prompt: `Synthetic scene ${n}`, createdAt: 1_700_000_000_000 + n, metadata: { adapter: "fake", model: "fixture" }, files: [{ path: "0.png", bytes: 3, format: "png" }], ...over });
const IMAGE = { manifest: out(1), data: "UE5H", mimeType: "image/png", canShare: false };

function serveAgents(server: MockHarnessServer, ids: string[]): void {
  server.extensions.unshift((_req: IncomingMessage, res: ServerResponse, path: string) => {
    if (path !== "/api/v1/agents") return false;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ schema: "agents.list/1", agents: ids.map((agentId) => ({ agentId, open: true, activity: { state: "idle", since: 1 } })) })); return true;
  });
}
function media(server: MockHarnessServer, outputs: unknown[] = [out(1), out(2)], o: { agents?: string[] } = {}): void {
  server.rpc.handle("media.output.list", () => ({ outputs }), { write: false }); server.rpc.handle("media.output.get", () => IMAGE, { write: false });
  server.rpc.handle("media.adapters.list", () => ({ adapters: [{ id: "fake", capabilities: { generate: true, edit: true } }] }), { write: false });
  serveAgents(server, o.agents ?? ["zeta"]);
}
const identities = (server: MockHarnessServer, list = { humanId: "owner", links: [{ id: "l1", channel: "signal-xyz", accountId: "bot", userId: "42" }, { id: "l2", channel: "matrix-abc", accountId: "bot2", userId: "43" }], pairings: [] as unknown[] }) => server.rpc.handle("identity.link.list", () => list, { write: false });

// ---- no fixed names ------------------------------------------------------------------------------------------------------

describe("surfaces use names the backend gave, never ones the page made up", opts, () => {
  test("Generate offers the agents the backend lists and sends the chosen one: no agent called 'main' is assumed", async () => {
    await withApp({}, async ({ page, server }) => {
      media(server, [out(1)], { agents: ["zeta", "omega"] }); server.rpc.handle("media.generate", () => ({ jobId: "job-1" })); server.rpc.handle("media.job.get", () => ({ state: "succeeded", progress: { fraction: 1 } }), { write: false });
      await openRoute(page, "#/media"); await page.getByRole("button", { name: "Generate image" }).first().click();
      const agent = page.locator("#agent"); await agent.waitFor(); assert.equal(await agent.evaluate((e) => e.tagName), "SELECT", "the agent is chosen from a list");
      await page.waitForFunction(() => document.querySelectorAll("#agent option").length >= 2);
      assert.deepEqual(await page.locator("#agent option").allInnerTexts(), ["zeta", "omega"]); assert.equal(await agent.inputValue(), "zeta");
      await agent.selectOption("omega"); await page.locator("#prompt").fill("a quiet harbour"); await page.getByRole("dialog").getByRole("button", { name: "Generate image" }).click();
      await page.waitForFunction(() => document.querySelector("dialog, [role=dialog]") === null);
      const call = server.rpc.calls.find((c) => c.method === "media.generate"); assert.equal((call!.params as { agentId: string }).agentId, "omega");
    });
  });

  test("with no agent to generate with, Generate says so and cannot be submitted", async () => {
    await withApp({}, async ({ page, server }) => {
      media(server, [out(1)], { agents: [] }); await openRoute(page, "#/media"); await page.getByRole("button", { name: "Generate image" }).first().click();
      await page.locator("#prompt").fill("anything"); await page.getByText(/no agent/i).waitFor();
      assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Generate image" }).isDisabled(), true);
    });
  });

  // `#/identities` was moved into Settings > Users & roles (router.ts MOVED, #387): the form below is src/pages/settings/users/identities.ts,
  // not src/pages/surfaces/identities.ts (dead since then). These regressions now cover that live Settings panel.
  test("the identity channel starts empty and is required; the suggestions are the channels this person already has", { skip: browserSkip }, async () => {
    await withApp({}, async ({ page, server }) => {
      identities(server); server.rpc.handle("identity.link.request", () => ({ code: "ABCD-EFGH", expiresAt: Date.now() + 600_000 })); await openRoute(page, "#/identities");
      await page.locator("#identity-channel").waitFor(); assert.equal(await page.locator("#identity-channel").inputValue(), "", "no channel is pre-filled");
      assert.deepEqual((await page.locator("#identity-channel").evaluate((e) => Array.from(document.querySelectorAll(`datalist#${(e as HTMLInputElement).getAttribute("list")} option`)).map((o) => (o as HTMLOptionElement).value))).sort(), ["matrix-abc", "signal-xyz"]);
      await page.getByRole("button", { name: "Issue pairing code" }).click(); await page.waitForTimeout(250);
      assert.equal(server.rpc.calls.filter((c) => c.method === "identity.link.request").length, 0, "an empty channel is not sent");
      await page.locator("#identity-channel").fill("signal-xyz"); await page.getByRole("button", { name: "Issue pairing code" }).click(); await page.getByText(/ABCD-EFGH/).waitFor();
      assert.deepEqual(server.rpc.calls.find((c) => c.method === "identity.link.request")!.params, { channel: "signal-xyz" });
    });
  });
});

// ---- messages, names, styles ---------------------------------------------------------------------------------------------

describe("surfaces tell the truth and stay readable", opts, () => {
  test("an error that was followed by a success is gone, not left on the page", { skip: browserSkip }, async () => {
    await withApp({}, async ({ page, server }) => {
      identities(server); let n = 0; server.rpc.handle("identity.link.request", () => { if (++n === 1) throw rpcError("E_INTERNAL", "boom"); return { code: "ABCD-EFGH", expiresAt: Date.now() + 600_000 }; });
      await openRoute(page, "#/identities"); await page.locator("#identity-channel").fill("signal-xyz");
      await page.getByRole("button", { name: "Issue pairing code" }).click(); await page.getByRole("alert").filter({ hasText: "The request failed" }).waitFor();
      await page.getByRole("button", { name: "Issue pairing code" }).click(); await page.getByText(/ABCD-EFGH/).waitFor();
      assert.equal(await page.getByRole("alert").filter({ hasText: "The request failed" }).count(), 0, "the old failure is still announced beside the success");
    });
  });

  test("the buttons of a list say which row they belong to, so a screen reader user can tell them apart", { skip: browserSkip }, async () => {
    await withApp({}, async ({ page, server }) => {
      identities(server); await openRoute(page, "#/identities"); await page.getByText("signal-xyz", { exact: false }).first().waitFor();
      const names = await page.locator("main").getByRole("button", { name: /remove/i }).evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim()));
      assert.equal(names.length, 2); assert.equal(new Set(names).size, 2, `identical names: ${JSON.stringify(names)}`);
      assert.ok(names.every((n) => /signal-xyz|matrix-abc/.test(n)), JSON.stringify(names));
    });
  });

  test("the page sets no inline style: pictures, rows and dialogs are styled by classes", async () => {
    await withApp({}, async ({ page, server }) => {
      media(server); await openRoute(page, "#/media"); await page.getByText("Synthetic scene 1").first().waitFor(); await page.locator("main img").first().waitFor({ state: "attached" });
      assert.equal(await page.locator("main [style]").count(), 0, `inline style on: ${(await page.locator("main [style]").evaluateAll((els) => els.map((e) => `${e.tagName}[style="${e.getAttribute("style")}"]`))).join(", ")}`);
      await page.getByRole("button", { name: /Synthetic scene 1/ }).first().click(); await page.getByRole("dialog").waitFor();
      assert.equal(await page.locator("[role=dialog] [style], dialog [style]").count(), 0);
    });
  });

  test("the source of the surfaces pages sets no style attribute either (string, ternary or object)", () => {
    const offences: string[] = [];
    for (const f of readdirSync(surfaces).filter((n) => n.endsWith(".ts"))) readFileSync(join(surfaces, f), "utf8").split("\n").forEach((line, i) => { if (/\bstyle:\s*[^,)\n]*["'`{]/.test(line) && !/Intl\.|currency/.test(line)) offences.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`); });
    assert.deepEqual(offences, []);
  });

  test("entries the backend sent half-formed are skipped, the good ones still show, and nothing crashes the page", async () => {
    await withApp({}, async ({ page, server, problems }) => {
      media(server, [out(1), { id: "x" }, null, 7, "text", { id: uuid(9), prompt: 5, agentId: {}, metadata: null }, out(2, { metadata: undefined }), { ...out(3), files: "none" }, out(4)]);
      await openRoute(page, "#/media"); await page.getByText("Synthetic scene 1").first().waitFor(); await page.getByText("Synthetic scene 4").first().waitFor();
      assert.ok((await page.locator(".media-grid article").count()) >= 2); assert.equal(await page.getByRole("heading", { name: "Media", level: 1 }).count(), 1);
      assert.deepEqual(problems, []);
    });
  });

  test("hostile and extreme text is shown as text and does not break the layout: HTML, bidi controls, a 5000-character word, 300 entries at 360 px", async () => {
    await withApp({ width: 360 }, async ({ page, server, problems }) => {
      const long = "W".repeat(5000);
      media(server, [out(1, { prompt: "<img src=x onerror=window.__pwned=1><script>window.__pwned=2</script>" }), out(2, { prompt: "‮gnp.exe‬ evil" }), out(3, { prompt: long }), ...Array.from({ length: 297 }, (_, i) => out(10 + i))]);
      await openRoute(page, "#/media"); await page.locator(".media-grid article").first().waitFor(); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined); assert.equal(await page.locator("main script, main img[src='x']").count(), 0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert.ok(overflow <= 0, `${overflow}px of horizontal scrolling with a long prompt at 360 px`);
      assert.deepEqual(problems.filter((p) => !/onerror/.test(p)), []);
    });
  });

  test("a job that answers without progress, or never finishes, neither crashes the page nor polls forever after leaving it", async () => {
    await withApp({}, async ({ page, server, problems }) => {
      media(server); server.rpc.handle("media.generate", () => ({ jobId: "job-1" })); let polls = 0; server.rpc.handle("media.job.get", () => { polls++; return { state: "running" }; }, { write: false });
      await openRoute(page, "#/media"); await page.getByRole("button", { name: "Generate image" }).first().click(); await page.locator("#prompt").fill("x"); await page.getByRole("dialog").getByRole("button", { name: "Generate image" }).click();
      await page.getByText(/job-1/).waitFor(); await page.waitForTimeout(1200); assert.equal(await page.getByRole("heading", { name: "Media", level: 1 }).count(), 1);
      await page.evaluate(() => { location.hash = "#/home"; }); await page.getByRole("heading", { name: "Welcome to PLUR1BUS", level: 1 }).waitFor(); const after = polls; await page.waitForTimeout(1500);
      assert.equal(polls, after, "the poll kept running after the page was left"); assert.deepEqual(problems, []);
    });
  });
});

// ---- roles and states ----------------------------------------------------------------------------------------------------

describe("surfaces by role and by state", opts, () => {
  for (const role of ["owner", "admin", "operator", "member", "viewer"] as const) {
    test(`${role}: write controls are there exactly for the roles that may write`, async () => {
      await withApp({ server: { role } }, async ({ page, server }) => {
        const writer = role !== "viewer"; media(server); identities(server);
        await openRoute(page, "#/media"); await page.getByText("Synthetic scene 1").first().waitFor();
        assert.equal(await page.getByRole("button", { name: "Generate image" }).count() > 0, writer, `${role}: Generate`);
        await page.getByRole("button", { name: /Synthetic scene 1/ }).first().click(); await page.getByRole("dialog").waitFor();
        assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Remove" }).count() > 0, writer, `${role}: Remove in the detail`);
        await page.keyboard.press("Escape"); await page.evaluate(() => { location.hash = "#/identities"; }); await page.getByText("signal-xyz", { exact: false }).first().waitFor();
        assert.equal(await page.getByRole("button", { name: "Issue pairing code" }).count() > 0, writer, `${role}: pairing`); assert.equal((await page.locator("main").getByRole("button", { name: /remove/i }).count()) > 0, writer, `${role}: unlink`);
      });
    });
  }

  for (const route of ["media", "identities"] as const) {
    const method = route === "media" ? "media.output.list" : "identity.link.list";
    const ok = route === "media" ? { outputs: [out(1)] } : { humanId: "owner", links: [{ id: "l1", channel: "signal-xyz", accountId: "b", userId: "1" }], pairings: [] };
    const run = (fn: (app: App) => Promise<void>) => withApp({}, async (app) => { app.server.rpc.handle(method, () => ok, { write: false }); app.server.rpc.handle("media.output.get", () => IMAGE, { write: false }); await fn(app); });

    test(`${route}: while loading, the wait is announced and the heading is already there`, async () => {
      await run(async ({ page, server }) => { server.rpc.setDelay(method, 1500); await openRoute(page, `#/${route}`); await page.locator("[role=status][aria-busy=true]").waitFor(); assert.equal(await page.locator("main h1").count(), 1); });
    });
    test(`${route}: an error offers Try again, which recovers without reloading the page`, async () => {
      await run(async ({ page, server }) => {
        server.rpc.scenario(method, "error"); await openRoute(page, `#/${route}`); await page.locator("[data-state=error]").waitFor();
        server.rpc.scenario(method, "success"); await page.getByRole("button", { name: "Try again" }).click(); await page.locator("[data-state=error]").waitFor({ state: "detached" });
        await page.getByText(route === "media" ? "Synthetic scene 1" : "signal-xyz", { exact: false }).first().waitFor();
      });
    });
    for (const [scenario, state] of [["forbidden", "forbidden"], ["unavailable", "unavailable"]] as const) {
      test(`${route}: ${scenario} is its own state, not an error and not an empty list`, async () => {
        await run(async ({ page, server }) => { server.rpc.scenario(method, scenario); await openRoute(page, `#/${route}`); await page.locator(`[data-state=${state}]`).waitFor(); assert.equal(await page.locator("[data-state=error], [data-state=empty]").count(), 0); });
      });
    }
  }
});

// ---- accessibility and keyboard ------------------------------------------------------------------------------------------

describe("surfaces are accessible and usable by keyboard", opts, () => {
  for (const [width, scheme, lang] of [[1440, "light", "en"], [360, "dark", "de"]] as const) {
    test(`axe finds nothing on media (grid, detail, generate) and identities (${width} px, ${scheme}, ${lang})`, async () => {
      await withApp({ width, colorScheme: scheme, locale: lang === "de" ? "de-DE" : "en-US" }, async ({ page, server }) => {
        media(server, [out(1), out(2)], { agents: ["zeta", "omega"] }); identities(server, { humanId: "owner", links: [{ id: "l1", channel: "signal-xyz", accountId: "bot", userId: "42" }], pairings: [{ id: "p1", channel: "matrix-abc", state: "claimed", expiresAt: Date.now() + 60_000 }] });
        await openRoute(page, "#/media", lang); await page.locator(".media-grid article").first().waitFor(); await page.waitForTimeout(400); await expectAxeClean(page, `media grid ${width}px ${scheme} ${lang}`);
        await page.locator(".media-grid article button").first().click(); await page.getByRole("dialog").waitFor(); await page.waitForTimeout(300); await expectAxeClean(page, `media detail ${width}px ${scheme} ${lang}`); await page.keyboard.press("Escape");
        await page.getByRole("button", { name: lang === "de" ? "Bild generieren" : "Generate image" }).first().click(); await page.getByRole("dialog").waitFor(); await page.waitForTimeout(300); await expectAxeClean(page, `generate ${width}px ${scheme} ${lang}`); await page.keyboard.press("Escape");
        await page.evaluate(() => { location.hash = "#/identities"; }); await page.getByText("signal-xyz", { exact: false }).first().waitFor(); await page.waitForTimeout(300); await expectAxeClean(page, `identities ${width}px ${scheme} ${lang}`);
      });
    });
  }

  test("a dialog keeps the focus inside while it is open, Escape closes it, and the focus goes back to the control that opened it", async () => {
    await withApp({}, async ({ page, server }) => {
      media(server); await openRoute(page, "#/media"); await page.locator(".media-grid article button").first().waitFor();
      const opener = page.locator(".media-grid article button").first(); await opener.focus(); await page.keyboard.press("Enter"); await page.getByRole("dialog").waitFor();
      for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); assert.ok(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog], dialog")), `Tab ${i} left the dialog`); }
      await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes("Synthetic scene 1") ?? false), true, "focus did not return to the card that opened the dialog");
      const gen = page.getByRole("button", { name: "Generate image" }).first(); await gen.focus(); await page.keyboard.press("Enter"); await page.getByRole("dialog").waitFor();
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog], dialog")), "focus moved into the Generate dialog"); await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" }); assert.equal(await page.evaluate(() => document.activeElement?.textContent ?? ""), "Generate image");
    });
  });
});
