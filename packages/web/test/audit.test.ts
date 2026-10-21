// Audit UI: real browser/view/API client against the repository's mock HTTP/RPC server; no real audit files or repair.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installAudit, NOW } from "./audit-fixtures.ts";

before(setup);
after(teardown);
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);
const section = (app: App) => app.page.getByRole("region", { name: "Audit" });
const open = async (app: App, lang: "en" | "de" = "en") => {
  await app.page.clock.setFixedTime(NOW);
  await openRoute(app.page, "#/logs/audit", lang);
};

describe("Audit section", { skip: browserSkip }, () => {
  test("loads appendability from status without claiming history integrity or automatically verifying", async () => {
    await withApp({}, async (app) => {
      installAudit(app.server); await open(app);
      await section(app).getByText("Accepting audit writes", { exact: true }).waitFor();
      await section(app).getByText("No successful verification recorded", { exact: true }).waitFor();
      assert.match(await section(app).innerText(), /does not verify the historical chain/);
      assert.equal(calls(app, "core.status").length, 1);
      assert.equal(calls(app, "audit.verify").length, 0);
      assert.equal(calls(app, "logs.query").length, 0);
      assert.equal(await section(app).getByRole("button", { name: /reanchor/i }).count(), 0);
      assert.match(await section(app).innerText(), /plur1bus audit reanchor --reason .* --dry-run/);
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });
  test("keyboard verification shows boundaries and the valid prefix of a broken old era separately", async () => {
    await withApp({}, async (app) => {
      installAudit(app.server); await open(app);
      const button = section(app).getByRole("button", { name: "Verify chain", exact: true });
      await button.focus(); await app.page.keyboard.press("Enter");
      await section(app).getByText("Current chain verified", { exact: true }).waitFor();
      await section(app).getByText("Valid through seq 41", { exact: true }).waitFor();
      assert.match(await section(app).innerText(), /Boundary at seq 1/);
      assert.match(await section(app).innerText(), /hash-mismatch/);
      assert.match(await section(app).innerText(), /does not repair or certify earlier eras/);
      assert.deepEqual(calls(app, "audit.verify").map((c) => c.params), [{}]);
      assert.ok(calls(app, "audit.verify").every((c) => c.csrf === null));
      assert.equal(calls(app, "audit.reanchor").length, 0);
    });
  });
  test("refusal and pending display only whitelisted metadata, never pending detail", async () => {
    await withApp({}, async (app) => {
      const fx = installAudit(app.server);
      Object.assign(fx.health, { state: "refusing", reason: "tail-anchor-mismatch", pendingLines: 3, pendingDropped: 2,
        lastReanchor: { at: NOW - 4000, actor: { user: "usr_admin", host: "offline" } },
        pending: [{ at: NOW - 100, actor: { user: "usr_owner", host: "local" }, action: "config.set", reason: "tail-anchor-mismatch", detail: "NEVER_RENDER_PRIVATE_DETAIL", target: "NEVER_RENDER_TARGET" }] });
      await open(app);
      await section(app).getByText("Refusing audit writes", { exact: true }).waitFor();
      const text = await section(app).innerText();
      for (const value of ["tail-anchor-mismatch", "config.set", "usr_owner", "usr_admin", "3 pending lines", "2 dropped"]) assert.ok(text.includes(value), value);
      assert.ok(!text.includes("NEVER_RENDER"));
      assert.equal(calls(app, "audit.verify").length, 0);
    });
  });
  test("Owner and Admin can read; other and unknown roles are forbidden without audit requests", async () => {
    for (const role of ["owner", "admin", "operator", "member", "viewer", "agent", "future-role"]) {
      await withApp({ server: { role } }, async (app) => {
        installAudit(app.server); await open(app);
        if (role === "owner" || role === "admin") await section(app).getByRole("button", { name: "Verify chain", exact: true }).waitFor();
        else {
          await app.page.locator(".page-state[data-state=forbidden]").waitFor();
          assert.equal(calls(app, "core.status").length, 0, role);
          assert.equal(calls(app, "audit.verify").length, 0, role);
        }
      });
    }
  });
  test("missing or malformed health is unavailable, never an optimistic OK", async () => {
    for (const audit of [undefined, { state: "ok" }, { ...installShape(), state: "unknown" }]) {
      await withApp({}, async (app) => {
        installAudit(app.server);
        app.server.rpc.handle("core.status", () => ({ audit }), { write: false }); await open(app);
        await section(app).locator(".page-state[data-state=unavailable]").waitFor();
        assert.equal(await section(app).getByText("Accepting audit writes", { exact: true }).count(), 0);
        assert.equal(await section(app).getByRole("button", { name: "Verify chain", exact: true }).count(), 1, "explicit verification remains usable");
      });
    }
  });
  test("health and verification fail independently with honest retry states", async () => {
    await withApp({}, async (app) => {
      installAudit(app.server); app.server.rpc.scenario("core.status", "error"); await open(app);
      await section(app).locator(".page-state[data-state=error]").waitFor();
      await section(app).getByRole("button", { name: "Verify chain", exact: true }).click();
      await section(app).getByText("Current chain verified", { exact: true }).waitFor();
    });
    for (const failure of ["forbidden", "unavailable", "error"] as const) {
      await withApp({}, async (app) => {
        installAudit(app.server); app.server.rpc.scenario("audit.verify", failure); await open(app);
        await section(app).getByRole("button", { name: "Verify chain", exact: true }).click();
        await section(app).locator(`.audit-verification .page-state[data-state=${failure}]`).waitFor();
        assert.equal(await section(app).getByText("Accepting audit writes", { exact: true }).count(), 1);
      });
    }
  });
  test("legacy verification has no invented era history; a failed current chain is explicit", async () => {
    await withApp({}, async (app) => {
      const fx = installAudit(app.server);
      app.server.rpc.handle("audit.verify", () => ({ ...fx.verify, reanchors: undefined, previousChains: undefined }), { write: false }); await open(app);
      await section(app).getByRole("button", { name: "Verify chain", exact: true }).click();
      await section(app).getByText("Era metadata is unavailable on this core.", { exact: true }).waitFor();
    });
    await withApp({}, async (app) => {
      const fx = installAudit(app.server);
      Object.assign(fx.verify, { ok: false, findingsTotal: 1, findings: [{ code: "hash-mismatch", file: "audit.jsonl", line: 9, seq: 9 }] }); await open(app);
      await section(app).getByRole("button", { name: "Verify chain", exact: true }).click();
      await section(app).getByText("Current chain has findings", { exact: true }).waitFor();
      assert.match(await section(app).locator(".audit-findings").innerText(), /hash-mismatch.*audit.jsonl.*9/);
    });
  });
  test("refresh replaces stale health, shows recorded timestamps and accepts empty era history", async () => {
    await withApp({}, async (app) => {
      const fx = installAudit(app.server); await open(app);
      await section(app).getByText("Accepting audit writes", { exact: true }).waitFor();
      Object.assign(fx.health, { state: "refusing", reason: "anchor-missing", lastVerifiedAt: NOW - 10000 });
      await section(app).getByRole("button", { name: "Refresh health", exact: true }).click();
      await section(app).getByText("Refusing audit writes", { exact: true }).waitFor();
      assert.equal(await section(app).getByText("No successful verification recorded", { exact: true }).count(), 0);
      assert.equal(calls(app, "core.status").length, 2);
      app.server.rpc.handle("audit.verify", () => ({ ...fx.verify, reanchors: [], previousChains: [] }), { write: false });
      await section(app).getByRole("button", { name: "Verify chain", exact: true }).click();
      await section(app).getByText("No earlier eras or reanchor boundaries reported.", { exact: true }).waitFor();
    });
  });
  test("an old anchor-only finding is not mislabeled as a line break; unannounced eras remain explicit", async () => {
    await withApp({}, async (app) => {
      const fx = installAudit(app.server);
      Object.assign(fx.verify.previousChains[0]!, { firstBreak: null, announced: false, anchor: { status: "absent", seq: null } });
      await open(app); await section(app).getByRole("button", { name: "Verify chain", exact: true }).click();
      await section(app).getByText("Stored era has findings", { exact: true }).waitFor();
      await section(app).getByText("No matching boundary announcement in the current chain.", { exact: true }).waitFor();
      await section(app).getByText("Valid through seq 41", { exact: true }).waitFor();
    });
  });
  test("invalid verification cannot announce success and metadata text cannot create markup", async () => {
    await withApp({}, async (app) => {
      const fx = installAudit(app.server);
      Object.assign(fx.health, { pendingLines: 1, pending: [{ at: NOW, actor: { user: "<img src=x onerror=alert(1)>", host: "local" }, action: "config.set", reason: null }] });
      app.server.rpc.handle("audit.verify", () => ({ ...fx.verify, lastSeq: -1 }), { write: false });
      await open(app); await section(app).getByRole("button", { name: "Verify chain", exact: true }).click();
      await section(app).locator(".audit-verification .page-state[data-state=error]").waitFor();
      assert.equal(await section(app).getByText("Current chain verified", { exact: true }).count(), 0);
      assert.match(await section(app).locator(".audit-pending").innerText(), /<img src=x onerror=alert\(1\)>/);
      assert.equal(await section(app).locator("img").count(), 0);
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });
  test("busy verification cannot double-submit and late responses do not update another tab", async () => {
    await withApp({}, async (app) => {
      installAudit(app.server); app.server.rpc.setDelay("audit.verify", 300); await open(app);
      const button = section(app).getByRole("button", { name: "Verify chain", exact: true });
      await button.click();
      assert.equal(await button.isDisabled(), true);
      await app.page.getByRole("tab", { name: "Sessions", exact: true }).click();
      await app.page.getByRole("tab", { name: "Audit", exact: true }).click();
      await section(app).getByText("Chain not checked in this view", { exact: true }).waitFor();
      assert.equal(calls(app, "audit.verify").length, 1);
      assert.equal(await section(app).getByText("Current chain verified", { exact: true }).count(), 0);
    });
  });
  test("English and German metadata, keyboard tab navigation, axe and narrow layout", async () => {
    for (const lang of ["en", "de"] as const) {
      await withApp({ width: 400, height: 800, locale: lang === "de" ? "de-DE" : "en-US" }, async (app) => {
        installAudit(app.server); await open(app, lang);
        const tab = app.page.getByRole("tab", { name: "Audit", exact: true });
        await tab.focus(); await app.page.keyboard.press("Home");
        await app.page.keyboard.press("End");
        await tab.waitFor(); assert.equal(await tab.getAttribute("aria-selected"), "true");
        const button = app.page.getByRole("button", { name: lang === "de" ? "Kette prüfen" : "Verify chain", exact: true });
        await button.focus(); await app.page.keyboard.press("Space");
        await app.page.getByText(lang === "de" ? "Gültig bis seq 41" : "Valid through seq 41", { exact: true }).waitFor();
        await expectAxeClean(app.page, `Audit ${lang}`);
        assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        assert.equal(await app.page.locator(".audit [style]").count(), 0);
        assert.equal(app.problems.length, 0, app.problems.join("\n"));
      });
    }
  });
});
function installShape() { return { state: "ok", reason: null, lastSeq: 1, observedAt: NOW, lastVerifiedAt: null, pendingLines: 0, pendingDropped: 0, pending: [], lastAnchorAdvanced: null, lastReanchor: null }; }
