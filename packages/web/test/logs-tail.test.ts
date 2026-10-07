// Log viewer live tail (K8): logs.tail long poll, anchor call, Pause/Resume with a bounded buffer and a throttled status region,
// back-off after failures, forbidden and unavailable tail, restart on filter change.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installLogsMocks, makeLines, makeRecord, type LogsMock } from "./logs-fixtures.ts";
import { rpcError } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const grid = (p: Page) => p.getByRole("grid", { name: "Log entries" });
const rows = (p: Page) => grid(p).locator('[role="row"][data-row]');
const pauseBtn = (p: Page) => p.getByRole("button", { name: "Pause live tail" });
const announce = (p: Page) => p.locator(".logs-announce");
const tailState = (p: Page) => p.locator(".logs-tail-state");

async function open(app: App, n = 30): Promise<LogsMock> {
  const m = installLogsMocks(app.server, { lines: makeLines(n) });
  await openRoute(app.page, "#/logs");
  await rows(app.page).first().waitFor();
  await tailState(app.page).getByText("Live").waitFor();
  return m;
}
/** Waits for the count line (rows are windowed, so DOM rows do not equal loaded rows). */
const loaded = (p: Page, n: string) => p.locator(".logs-count").getByText(`${n} entries loaded`, { exact: true }).waitFor();
const first = async (p: Page) => (await rows(p).first().textContent()) ?? "";

describe("logs tail", opts, () => {
  test("anchors with a one-line call, then long-polls with the cursor, the filters and waitMs", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      while (m.tails().length < 2) await new Promise((r) => setTimeout(r, 20));
      const [anchor, follow] = m.tails() as [Record<string, unknown>, Record<string, unknown>];
      assert.deepEqual(anchor, { stream: "diagnostic", limit: 1 });
      assert.equal(follow.cursor, "t30");
      assert.equal(follow.stream, "diagnostic");
      assert.equal(typeof follow.waitMs, "number");
      assert.ok((follow.waitMs as number) > 0 && (follow.waitMs as number) <= 30000);
      assert.equal(follow.from, undefined);
      await loaded(app.page, "30");
    });
  });

  test("new lines appear at the top while live", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      m.push(makeRecord(31), makeRecord(32));
      await loaded(app.page, "32");
      assert.ok((await first(app.page)).includes("entry 00032"));
    });
  });

  test("lines arriving while the reader is scrolled down do not move what is on screen", async () => {
    await withApp({}, async (app) => {
      const m = await open(app, 200);
      await app.page.evaluate(() => { document.querySelector<HTMLElement>(".logs-viewport")!.scrollTop = 1800; });
      await app.page.waitForFunction(() => { const r = document.querySelector('[role="row"][data-row]'); return r !== null && Number(r.getAttribute("aria-rowindex")) > 20; });
      const probe = () => app.page.evaluate(() => {
        const v = document.querySelector<HTMLElement>(".logs-viewport")!.getBoundingClientRect();
        const row = Array.from(document.querySelectorAll<HTMLElement>('[role="row"][data-row]')).find((r) => r.getBoundingClientRect().top >= v.top + 40)!;
        return { text: row.textContent ?? "", offset: Math.round(row.getBoundingClientRect().top - v.top) };
      });
      const before = await probe();
      m.push(makeRecord(201), makeRecord(202), makeRecord(203));
      await loaded(app.page, "203");
      await app.page.waitForFunction((t) => Array.from(document.querySelectorAll('[role="row"][data-row]')).some((r) => r.textContent === t), before.text);
      assert.deepEqual(await probe(), before);
    });
  });

  test("Pause keeps the list still and counts new entries; Resume shows them", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      const btn = pauseBtn(app.page);
      assert.equal(await btn.getAttribute("aria-pressed"), "false");
      await btn.click();
      assert.equal(await btn.getAttribute("aria-pressed"), "true");
      await tailState(app.page).getByText("Paused").waitFor();
      m.push(makeRecord(31), makeRecord(32), makeRecord(33));
      await app.page.locator(".logs-new").getByText("3 new entries").waitFor();
      await loaded(app.page, "30");
      assert.ok((await first(app.page)).includes("entry 00030"));
      await btn.click();
      assert.equal(await btn.getAttribute("aria-pressed"), "false");
      await loaded(app.page, "33");
      assert.ok((await first(app.page)).includes("entry 00033"));
      assert.equal(await app.page.locator(".logs-new").count(), 0);
    });
  });

  test("the paused buffer is bounded and says how many entries it dropped", async () => {
    await withApp({}, async (app) => {
      const m = await open(app, 5);
      await pauseBtn(app.page).click();
      for (let b = 0; b < 5; b++) m.push(...Array.from({ length: 500 }, (_, i) => makeRecord(100 + b * 500 + i)));
      await app.page.locator(".logs-new").getByText("2,000 new entries").waitFor();
      await app.page.locator(".logs-new").getByText("500 of them were dropped from the buffer.").waitFor();
      await pauseBtn(app.page).click();
      await loaded(app.page, "2,005");
    });
  });

  test("the live region is polite, separate from the list, and announces at most every few seconds", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      assert.equal(await announce(app.page).getAttribute("aria-live"), "polite");
      assert.equal(await app.page.evaluate(() => !!document.querySelector('[role="grid"]')?.closest("[aria-live]")), false);
      assert.equal(await app.page.evaluate(() => document.querySelector('[role="grid"]')?.querySelector("[aria-live]") === null), true);
      await pauseBtn(app.page).click();
      await app.page.evaluate(() => {
        const w = window as unknown as { __announced: string[] };
        w.__announced = [];
        new MutationObserver(() => { w.__announced.push(document.querySelector(".logs-announce")?.textContent ?? ""); }).observe(document.querySelector(".logs-announce")!, { childList: true, characterData: true, subtree: true });
      });
      for (let i = 0; i < 12; i++) { m.push(makeRecord(200 + i)); await app.page.locator(".logs-new").getByText(i === 0 ? "1 new entry" : `${i + 1} new entries`).waitFor(); }
      const seen = await app.page.evaluate(() => (window as unknown as { __announced: string[] }).__announced);
      assert.ok(seen.length <= 3, `announced ${seen.length} times: ${seen.join(" | ")}`);
    });
  });

  test("a failing tail backs off, shows Reconnecting and recovers while the list stays", async () => {
    await withApp({}, async (app) => {
      const m = installLogsMocks(app.server, { lines: makeLines(10) });
      let failures = 1;
      const real = m.lines;
      app.server.rpc.handle("logs.tail", (p) => {
        const params = p as { cursor?: string };
        if (params.cursor !== undefined && failures-- > 0) throw rpcError("E_INTERNAL", "tail down");
        return { records: params.cursor === undefined ? real.slice(-1) : [], nextCursor: `t${real.length}`, corrupt: 0, scanned: { files: 1, bytes: 1 }, truncated: false };
      }, { write: false });
      await openRoute(app.page, "#/logs");
      await tailState(app.page).getByText("Reconnecting…").waitFor();
      await loaded(app.page, "10");
      await tailState(app.page).getByText("Live").waitFor();
    });
  });

  test("a tail the role may not use, or the harness lacks, is explained without hiding the list", async () => {
    await withApp({}, async (app) => {
      const m = installLogsMocks(app.server, { lines: makeLines(10), tail: false });
      app.server.rpc.handle("logs.tail", () => { throw rpcError("E_DENIED", "no", "no-permission"); }, { write: false });
      await openRoute(app.page, "#/logs");
      await tailState(app.page).getByText("Your role does not allow live tail.").waitFor();
      await loaded(app.page, "10");
      assert.equal(m.tails().length, 1, "no retry loop on a denied tail");
    });
    await withApp({}, async (app) => {
      installLogsMocks(app.server, { lines: makeLines(10), tail: false });
      await openRoute(app.page, "#/logs");
      await tailState(app.page).getByText("Live tail is not available on this harness.").waitFor();
      assert.equal(await pauseBtn(app.page).isDisabled(), true);
    });
  });

  test("oldest-first order or an end time turns the tail off and says why; applying filters restarts it with them", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      const f = app.page.getByRole("search", { name: "Log filters" });
      await f.getByLabel("Order").selectOption("asc");
      await f.getByRole("button", { name: "Apply filters" }).click();
      await tailState(app.page).getByText("Live tail is off for oldest-first order and for ranges with an end time.").waitFor();
      const calls = m.tails().length;
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(m.tails().length, calls, "no tail calls while off");
      await f.getByLabel("Order").selectOption("desc");
      await f.getByLabel("Minimum level").selectOption("warn");
      await f.getByRole("button", { name: "Apply filters" }).click();
      await tailState(app.page).getByText("Live").waitFor();
      while (!m.tails().some((c) => c.minLevel === "warn")) await new Promise((r) => setTimeout(r, 20));
      const t = m.tails().find((c) => c.minLevel === "warn")!;
      assert.deepEqual(t, { stream: "diagnostic", minLevel: "warn", limit: 1 });
    });
  });
});
