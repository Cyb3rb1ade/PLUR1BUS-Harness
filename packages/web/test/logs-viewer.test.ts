// Log viewer (K8, route /logs, tab Logs): states, filters and their exact logs.query parameters, pagination, detail with redaction
// markers, copy, export, German. Runs against the mock /rpc server; the live tail has its own file (logs-tail.test.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installLogsMocks, makeLines, makeRecord, type LogsMock } from "./logs-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const grid = (p: Page) => p.getByRole("grid", { name: "Log entries" });
const rows = (p: Page) => grid(p).locator('[role="row"][data-row]');
const filters = (p: Page) => p.getByRole("search", { name: "Log filters" });

async function open(app: App, init: Parameters<typeof installLogsMocks>[1] = { tail: false }, lang: "en" | "de" = "en"): Promise<LogsMock> {
  const mock = installLogsMocks(app.server, init);
  await openRoute(app.page, "#/logs", lang);
  return mock;
}
/** Waits until the list shows exactly n loaded entries (the count line; rows are windowed, so counting DOM rows would not do). */
const loaded = (p: Page, n: number) => p.getByText(n === 1 ? "1 entry loaded" : `${n} entries loaded`, { exact: true }).waitFor();
/** Waits until the viewer has asked n times and is no longer loading. */
async function settled(app: App, m: LogsMock, n: number): Promise<void> {
  await app.page.waitForFunction(() => !document.querySelector('[data-state="loading"]'));
  while (m.queries().length < n) await new Promise((r) => setTimeout(r, 10));
  await app.page.waitForFunction(() => !document.querySelector('[data-state="loading"]'));
}
const firstQuery = (m: LogsMock) => m.queries()[0]!;

describe("logs viewer: list and states", opts, () => {
  test("loads the newest 200 entries first with the default parameters", async () => {
    await withApp({}, async (app) => {
      const m = await open(app, { lines: makeLines(300), tail: false });
      await rows(app.page).first().waitFor();
      assert.deepEqual(firstQuery(m), { stream: "diagnostic", order: "desc", limit: 200 });
      assert.ok(((await rows(app.page).first().textContent()) ?? "").includes("entry 00300"), "newest entry on top");
      await app.page.getByText("200 entries loaded").waitFor();
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });

  test("empty without filters says the log is empty; with filters it offers Clear filters, which reloads unfiltered", async () => {
    await withApp({}, async (app) => {
      const m = await open(app, { lines: [], tail: false });
      await app.page.getByText("The log has no entries yet.").waitFor();
      m.lines.push(...makeLines(3));
      await filters(app.page).getByLabel("Search text").fill("zzz-nothing");
      await filters(app.page).getByRole("button", { name: "Apply filters" }).click();
      await app.page.getByRole("heading", { name: "No matching entries" }).waitFor();
      await app.page.locator('[data-state="empty"]').getByRole("button", { name: "Clear filters" }).click();
      await rows(app.page).first().waitFor();
      assert.equal(await rows(app.page).count(), 3);
      assert.equal(m.queries().at(-1)?.text, undefined);
      assert.equal(await filters(app.page).getByLabel("Search text").inputValue(), "");
    });
  });

  test("an error shows Try again, which asks again and recovers", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      await rows(app.page).first().waitFor();
      app.server.rpc.scenario("logs.query", "error", { code: "E_INTERNAL", message: "boom" });
      await filters(app.page).getByRole("button", { name: "Apply filters" }).click();
      await app.page.getByRole("button", { name: "Try again" }).waitFor();
      app.server.rpc.scenario("logs.query", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await rows(app.page).first().waitFor();
      assert.ok(m.queries().length >= 3);
    });
  });

  test("E_DENIED from the server is the forbidden state", async () => {
    await withApp({}, async (app) => {
      await open(app);
      app.server.rpc.scenario("logs.query", "forbidden");
      await filters(app.page).getByRole("button", { name: "Apply filters" }).click();
      await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
    });
  });

  test("a role that may not read logs sees the forbidden state without any logs call", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      const m = await open(app);
      await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
      assert.equal(m.queries().length, 0);
    });
  });

  test("a harness without logs.query shows the unavailable state", async () => {
    await withApp({}, async (app) => {
      await open(app, { query: false, tail: false });
      await app.page.getByRole("heading", { name: "Logs are not available" }).waitFor();
    });
  });

  test("the loading state shows while the first page is on its way", async () => {
    await withApp({}, async (app) => {
      installLogsMocks(app.server, { tail: false });
      app.server.rpc.setDelay("logs.query", 400);
      await openRoute(app.page, "#/logs");
      await app.page.getByText("Loading…").first().waitFor();
      await rows(app.page).first().waitFor();
    });
  });

  test("server notes (unreadable lines) are shown", async () => {
    await withApp({}, async (app) => {
      await open(app);
      app.server.rpc.handle("logs.query", () => ({ records: [makeRecord(1)], nextCursor: null, corrupt: 3, scanned: { files: 1, bytes: 1 }, truncated: false }), { write: false });
      await filters(app.page).getByRole("button", { name: "Apply filters" }).click();
      await app.page.getByText("3 unreadable lines were skipped by the server.").waitFor();
    });
  });
});

describe("logs viewer: filters", opts, () => {
  const apply = (p: Page) => filters(p).getByRole("button", { name: "Apply filters" }).click();
  /** Applies and waits for the answer to that query. */
  async function applied(app: App, m: LogsMock): Promise<void> { const n = m.queries().length; await apply(app.page); await settled(app, m, n + 1); }

  test("level, component, text, order and a preset range become exact parameters", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      await rows(app.page).first().waitFor();
      const f = filters(app.page);
      await f.getByLabel("Minimum level").selectOption("warn");
      await f.getByLabel("Component").fill("core");
      await f.getByLabel("Search text").fill("entry");
      await f.getByLabel("Order").selectOption("asc");
      await f.getByLabel("Time range").selectOption("1h");
      const before = Date.now();
      await applied(app, m);
      const q = m.queries().at(-1)!;
      const { from, ...rest } = q;
      assert.deepEqual(rest, { stream: "diagnostic", minLevel: "warn", component: "core", text: "entry", order: "asc", limit: 200 });
      const fromMs = Date.parse(String(from));
      assert.ok(Math.abs(fromMs - (before - 3_600_000)) < 10_000, `from ${String(from)}`);
    });
  });

  test("the 15 minute and 24 hour presets and the audit stream (no minLevel)", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      await rows(app.page).first().waitFor();
      const f = filters(app.page);
      await f.getByLabel("Time range").selectOption("15m");
      await applied(app, m);
      assert.ok(Math.abs(Date.now() - 900_000 - Date.parse(String(m.queries().at(-1)!.from))) < 10_000);
      await f.getByLabel("Time range").selectOption("24h");
      await f.getByLabel("Minimum level").selectOption("error");
      await f.getByLabel("Stream").selectOption("audit");
      assert.equal(await f.getByLabel("Minimum level").isDisabled(), true);
      await applied(app, m);
      await app.page.getByRole("heading", { name: "No matching entries" }).waitFor();
      const q = m.queries().at(-1)!;
      assert.equal(q.stream, "audit");
      assert.equal(q.minLevel, undefined);
      assert.ok(Math.abs(Date.now() - 86_400_000 - Date.parse(String(q.from))) < 10_000);
    });
  });

  test("a custom range shows From and To and sends them as UTC", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      await rows(app.page).first().waitFor();
      const f = filters(app.page);
      assert.equal(await f.getByLabel("From").count(), 0);
      await f.getByLabel("Time range").selectOption("custom");
      await f.getByLabel("From").fill("2026-10-07T10:00");
      await f.getByLabel("To").fill("2026-10-07T12:00");
      await applied(app, m);
      const q = m.queries().at(-1)!;
      const expect = await app.page.evaluate(() => [new Date("2026-10-07T10:00").toISOString(), new Date("2026-10-07T12:00").toISOString()]);
      assert.deepEqual([q.from, q.to], expect);
      await f.getByLabel("From").fill("2026-10-07T13:00");
      const n = m.queries().length;
      await apply(app.page);
      await app.page.getByText("From must not be after To.").waitFor();
      assert.equal(m.queries().length, n, "an inverted range sends nothing");
    });
  });

  test("a trace id is sent as text, the help says so, and it cannot be combined with a search text", async () => {
    await withApp({}, async (app) => {
      const m = await open(app, { lines: makeLines(40), tail: false });
      await rows(app.page).first().waitFor();
      const f = filters(app.page);
      await f.getByText("The server has no trace filter, so the ID is searched as text.", { exact: false }).waitFor();
      await f.getByLabel("Trace ID").fill("trace0030");
      await applied(app, m);
      await loaded(app.page, 1);
      assert.equal(m.queries().at(-1)!.text, "trace0030");
      await f.getByLabel("Search text").fill("x");
      const n = m.queries().length;
      await apply(app.page);
      await app.page.getByText("Use either a trace ID or a search text, not both.").waitFor();
      assert.equal(m.queries().length, n);
    });
  });

  test("Enter in a text field applies the filters; Clear filters resets every field", async () => {
    await withApp({}, async (app) => {
      const m = await open(app);
      await rows(app.page).first().waitFor();
      const f = filters(app.page);
      await f.getByLabel("Search text").fill("entry 00007");
      await f.getByLabel("Search text").press("Enter");
      await loaded(app.page, 1);
      assert.equal(m.queries().at(-1)!.text, "entry 00007");
      await f.getByRole("button", { name: "Clear filters" }).click();
      await loaded(app.page, 30);
      assert.equal(await f.getByLabel("Search text").inputValue(), "");
      assert.deepEqual(m.queries().at(-1), { stream: "diagnostic", order: "desc", limit: 200 });
    });
  });

  test("a trace id in the route (?trace=) prefills the filter and the first query", async () => {
    await withApp({}, async (app) => {
      const m = installLogsMocks(app.server, { lines: makeLines(40), tail: false });
      await openRoute(app.page, "#/logs?trace=trace0020");
      await loaded(app.page, 1);
      assert.equal(firstQuery(m).text, "trace0020");
      assert.equal(await filters(app.page).getByLabel("Trace ID").inputValue(), "trace0020");
    });
  });
});

describe("logs viewer: pagination", opts, () => {
  test("Load older passes the cursor with the same filters, appends, and ends with a note", async () => {
    await withApp({}, async (app) => {
      const m = await open(app, { lines: makeLines(450), tail: false });
      await rows(app.page).first().waitFor();
      const more = app.page.getByRole("button", { name: "Load older" });
      await more.click();
      await app.page.getByText("400 entries loaded").waitFor();
      assert.equal(m.queries()[1]!.cursor, "200");
      assert.deepEqual({ ...m.queries()[1]!, cursor: undefined }, { stream: "diagnostic", order: "desc", limit: 200, cursor: undefined });
      await more.click();
      await app.page.getByText("450 entries loaded").waitFor();
      assert.equal(await more.count(), 0);
      await app.page.getByText("End of the log.").waitFor();
      assert.equal(await grid(app.page).getAttribute("aria-rowcount"), "451");
    });
  });

  test("oldest-first order loads newer pages and a failing page keeps the rows with a retry", async () => {
    await withApp({}, async (app) => {
      await open(app, { lines: makeLines(450), tail: false });
      await rows(app.page).first().waitFor();
      await filters(app.page).getByLabel("Order").selectOption("asc");
      await filters(app.page).getByRole("button", { name: "Apply filters" }).click();
      await loaded(app.page, 200);
      await app.page.waitForFunction(() => document.querySelector('[role="row"][data-row]')?.textContent?.includes("entry 00001"));
      app.server.rpc.scenario("logs.query", "error");
      await app.page.getByRole("button", { name: "Load newer" }).click();
      await app.page.getByText("More entries could not be loaded.").waitFor();
      assert.equal(await rows(app.page).count() > 0, true);
      app.server.rpc.scenario("logs.query", "success");
      await app.page.getByRole("button", { name: "Load newer" }).click();
      await app.page.getByText("400 entries loaded").waitFor();
    });
  });
});

describe("logs viewer: detail, redaction, copy", opts, () => {
  test("Enter opens the detail dialog with all fields; Escape closes it and focus returns to the list", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await rows(app.page).first().waitFor();
      await grid(app.page).focus();
      await app.page.keyboard.press("ArrowDown");
      await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog", { name: "Log entry" });
      await dlg.waitFor();
      const text = (await dlg.textContent()) ?? "";
      for (const part of ["entry 00029", "core.tick", "harness", "2026-10-07T11:00:29.000Z", "info"]) assert.ok(text.includes(part), `detail lacks ${part}`);
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(await app.page.evaluate(() => document.activeElement?.getAttribute("role")), "grid");
    });
  });

  test("redacted values are marked with text and an icon, in the row and in the detail", async () => {
    await withApp({}, async (app) => {
      await open(app, { lines: [makeRecord(7)], tail: false });
      const row = rows(app.page).first();
      await row.waitFor();
      await row.getByText("Redacted").waitFor();
      await row.click();
      const dlg = app.page.getByRole("dialog", { name: "Log entry" });
      await dlg.getByText("[REDACTED:secret-key]").waitFor();
      assert.ok(await dlg.locator(".logs-redacted svg").count() > 0, "icon next to the marker");
      await dlg.getByText("Redacted by the server (secret-key).", { exact: false }).waitFor();
      assert.ok(((await dlg.textContent()) ?? "").includes("visible"), "non-redacted values stay");
    });
  });

  test("an entry without redaction has no redaction note", async () => {
    await withApp({}, async (app) => {
      await open(app, { lines: [makeRecord(1)], tail: false });
      await rows(app.page).first().click();
      const dlg = app.page.getByRole("dialog", { name: "Log entry" });
      await dlg.waitFor();
      assert.equal(await dlg.getByText("Redacted by the server", { exact: false }).count(), 0);
      assert.equal(await app.page.getByRole("row").getByText("Redacted").count(), 0);
    });
  });

  test("copy buttons put the field and the whole record on the clipboard and say so", async () => {
    await withApp({}, async (app) => {
      await app.context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await open(app, { lines: [makeRecord(10)], tail: false });
      await rows(app.page).first().click();
      const dlg = app.page.getByRole("dialog", { name: "Log entry" });
      await dlg.getByRole("button", { name: "Copy trace_id" }).click();
      assert.equal(await app.page.evaluate(() => navigator.clipboard.readText()), "trace0010");
      await dlg.getByText("Copied trace_id.").waitFor();
      await dlg.getByRole("button", { name: "Copy record as JSON" }).click();
      const copied = JSON.parse(await app.page.evaluate(() => navigator.clipboard.readText())) as Record<string, unknown>;
      assert.equal(copied.msg, "entry 00010");
    });
  });
});

describe("logs viewer: export", opts, () => {
  async function download(app: App, name: string): Promise<{ file: string; text: string }> {
    const [dl] = await Promise.all([app.page.waitForEvent("download"), app.page.getByRole("button", { name }).click()]);
    const path = await dl.path();
    return { file: dl.suggestedFilename(), text: await readFile(path, "utf8") };
  }

  test("exports exactly the loaded, filtered rows as NDJSON and as JSON", async () => {
    await withApp({}, async (app) => {
      const m = await open(app, { lines: makeLines(30), tail: false });
      await rows(app.page).first().waitFor();
      await filters(app.page).getByLabel("Minimum level").selectOption("warn");
      await filters(app.page).getByRole("button", { name: "Apply filters" }).click();
      await loaded(app.page, 10);
      const expected = m.lines.filter((r) => r.level === "warn" || r.level === "error").reverse();
      assert.equal(expected.length, 10);
      const nd = await download(app, "Export NDJSON");
      assert.match(nd.file, /^plur1bus-logs-.*\.ndjson$/);
      assert.deepEqual(nd.text.trimEnd().split("\n").map((l) => JSON.parse(l)), expected);
      const js = await download(app, "Export JSON");
      assert.match(js.file, /\.json$/);
      assert.deepEqual(JSON.parse(js.text), expected);
      await app.page.getByText("Exported 10 loaded entries.").waitFor();
      assert.ok(nd.text.includes("[REDACTED:secret-key]"), "redaction markers stay as the server sent them");
    });
  });

  test("export is disabled while there is nothing to export", async () => {
    await withApp({}, async (app) => {
      await open(app, { lines: [], tail: false });
      await app.page.getByText("The log has no entries yet.").waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Export NDJSON" }).isDisabled(), true);
    });
  });
});

describe("logs viewer: German", opts, () => {
  test("labels, states and the level words are German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      await open(app, { lines: makeLines(5), tail: false }, "de");
      await app.page.getByRole("search", { name: "Protokollfilter" }).waitFor();
      await app.page.getByRole("grid", { name: "Protokolleinträge" }).waitFor();
      await app.page.getByText("5 Einträge geladen").waitFor();
      await app.page.getByRole("button", { name: "NDJSON exportieren" }).waitFor();
    });
  });
});

