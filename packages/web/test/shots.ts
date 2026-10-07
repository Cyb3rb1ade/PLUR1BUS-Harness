// Screenshots of the seven pages (chat, memories, dreams, models, usage, doctor, palette) in light and dark at 400 px (compact)
// and 1600 px (wide), against the mock server with filled fixtures. Not a test; run by hand and for PR screenshots:
//   PLUR1BUS_WEB_SHOTS_DIR=<dir> pnpm --filter @plur1bus/web exec node --experimental-strip-types test/shots.ts
// Files: <page>-<hell|dunkel>-<compact|wide>.png (hell = light, dunkel = dark). PLUR1BUS_WEB_SHOTS_ONLY=chat,doctor narrows the pages.
// PLUR1BUS_WEB_SHOTS_CHECK=1 also reports, per shot, horizontal overflow, axe violations and interactive targets below 24 px
// (44 px high in compact, < 1024 px); PLUR1BUS_WEB_SHOTS_WIDTHS=400,640,960,1440,2560 replaces the two widths (files: w<width>).
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { axeViolations } from "./axe.ts";
import { FakeChat, stubAgents, AGENTS } from "./chat-fixtures.ts";
import { AGENTS as DOCTOR_AGENTS, CORE_OK, DoctorMock, HEALTH_DEGRADED } from "./doctor-fixtures.ts";
import { browserSkip, getDistDir, openRoute, setup, signIn, teardown, withApp, type App } from "./harness.ts";
import { defaultFixture, installMemoryMocks } from "./memory-fixtures.ts";
import type { MockRpc } from "./mock-rpc.ts";

type Rec = Record<string, unknown>;

const M = (o: Rec = {}): Rec => ({
  provider: "openai", id: "gpt-5", displayName: "GPT-5", kind: "chat", contextWindow: 400000, capabilities: ["tools", "vision"], aliases: ["gpt5"],
  status: "available", firstSeen: "2026-10-03T07:12:44.120Z", lastSeen: "2026-10-03T07:12:44.120Z", source: "scan", overrides: {}, ...o,
});
function seedModels(rpc: MockRpc): void {
  const models = [
    M(), M({ id: "gpt-4o", displayName: "GPT-4o", firstSeen: "2026-01-01T00:00:00Z" }),
    M({ id: "gpt-3", displayName: "GPT-3", status: "unavailable" }),
    M({ provider: "anthropic", id: "claude-x", displayName: "Claude X", kind: "unknown", contextWindow: undefined, capabilities: [], aliases: [], note: "visible-note" }),
    M({ provider: "local", id: "my/llama:8b", displayName: "My Llama", source: "manual", status: "manual", overrides: { displayName: "My Llama" } }),
  ];
  rpc.handle("models.list", () => ({
    models, newCount: 1, warnings: [{ code: "role_unavailable", role: "default", provider: "openai", id: "gpt-3" }],
    providers: [{ provider: "openai", lastScanAt: "2026-10-03T07:12:44.120Z", lastResult: "ok" }, { provider: "anthropic", lastResult: "failed:auth", consecutiveFailures: 2 }],
  }), { write: false });
}

const lim = (o: Rec): Rec => ({ period: "day", metric: "cost", soft: null, hard: null, used: 0, state: "ok", ...o });
const usage = (o: Rec = {}): Rec => ({ events: 4, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 10, costMicros: 1500, unpricedEvents: 1, ...o });
function seedBudget(rpc: MockRpc): void {
  const limits = [
    lim({ scope: "global", period: "day", metric: "cost", soft: 5_000_000, hard: 10_000_000, used: 2_000_000, state: "ok" }),
    lim({ scope: "global", period: "month", metric: "tokens", soft: 1_000_000, hard: 2_000_000, used: 1_500_000, state: "soft" }),
    lim({ scope: "agent", agentId: "main", period: "day", metric: "cost", hard: 1_000_000, used: 1_200_000, state: "hard" }),
    lim({ scope: "agent", agentId: "dev", period: "month", metric: "tokens", soft: 500, used: 500, state: "soft" }),
  ];
  const periods = [
    { period: "day", key: "2026-10-07", start: "2026-10-07T00:00:00+02:00", end: "2026-10-08T00:00:00+02:00", total: usage(), agents: [{ agentId: "main", total: usage(), models: [{ model: "claude-x", ...usage() }] }] },
    { period: "month", key: "2026-10", start: "2026-10-01T00:00:00+02:00", end: "2026-11-01T00:00:00+01:00", total: usage({ events: 40 }), agents: [] },
  ];
  rpc.handle("budget.status", () => ({ timeZone: "Europe/Berlin", priceVersion: "2026-10-01", now: "2026-10-07T09:00:00+02:00", periods, limits }), { write: false });
}

const LONG = "Ich habe die Ergebnisse zusammengefasst. Die drei wichtigsten Punkte: erstens läuft der Import stabil, zweitens ist die Latenz der Suche unter 40 ms geblieben, drittens fehlt noch ein Test für den Fall, dass die Konfiguration während eines Laufs geändert wird.\n\nSoll ich damit weitermachen?";
function seedChat(c: FakeChat): void {
  c.seed({ id: "ses_1", title: "Import und Suche prüfen", messages: [["user", "Wie ist der Stand beim Import?"], ["assistant", LONG], ["user", "Ja, bitte."]] });
  c.seed({ id: "ses_2", title: "Notizen von gestern", memoryMode: "incognito", agentId: "mara" });
  c.seed({ id: "ses_3", title: "Ein sehr langer Titel für eine Unterhaltung, der in der Liste umbrechen muss, ohne die Seite zu verbreitern" });
}

type Shot = { name: string; run: (theme: "light" | "dark", width: number, file: string) => Promise<void> };
const CUSTOM = process.env.PLUR1BUS_WEB_SHOTS_WIDTHS?.split(",").map(Number).filter((n) => n > 0);
const WIDTHS: Record<string, number> = CUSTOM ? Object.fromEntries(CUSTOM.map((w) => [`w${w}`, w])) : { compact: 400, wide: 1600 };
const CHECK = process.env.PLUR1BUS_WEB_SHOTS_CHECK === "1";
const findings: string[] = [];

async function check(page: Page, label: string): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const r = await page.evaluate((w) => {
    const compact = w < 1024;
    const doc = document.documentElement;
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=tab], [role=option]")) {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (b.width === 0 || b.height === 0 || cs.visibility === "hidden" || el.closest("[hidden]") || el.classList.contains("sr-only") || el.classList.contains("skip-link") || el.closest(".sidebar:not([data-open=true]) .wordmark")) continue; // skip link is shown on focus only; the rail wordmark is hidden text
      if (el.tagName === "A" && el.closest("p, li, dd, .state-body") && el.className === "") continue; // inline text link (WCAG 2.5.8 exception)
      const need = compact && !el.closest(".msg") ? 44 : 24;
      if (b.height < need - 0.5 || b.width < 24 - 0.5) small.push(`${el.tagName.toLowerCase()}.${el.className.toString().split(" ")[0] ?? ""} ${Math.round(b.width)}x${Math.round(b.height)} "${(el.textContent ?? "").trim().slice(0, 24)}"`);
    }
    return { overflow: doc.scrollWidth - doc.clientWidth, small };
  }, width);
  if (r.overflow > 0) findings.push(`${label}: horizontal overflow ${r.overflow}px`);
  for (const x of new Set(r.small)) findings.push(`${label}: small target ${x}`);
  for (const v of await axeViolations(page)) findings.push(`${label}: axe ${v.id} (${v.impact}) ${v.nodes.slice(0, 2).map((n) => JSON.stringify(n.target)).join(" ")}`);
}
const SCHEME = { light: "hell", dark: "dunkel" } as const;

async function settle(page: Page, file: string): Promise<void> {
  if (CHECK) await check(page, file.split("/").pop()!);
  await page.evaluate(() => document.fonts.ready);
  // One viewport as tall as the page (capped), not fullPage: the sticky sidebar then fills the left edge instead of floating mid-page.
  const width = page.viewportSize()?.width ?? 1440;
  const height = await page.evaluate(() => Math.min(Math.max(document.documentElement.scrollHeight, 600), 2600));
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  await page.screenshot({ path: file });
}

/** The bundle may be split into chunks/ (lazy pages); serve them even when the mock server only knows flat file names, then reload. */
async function serveChunks(app: App): Promise<void> {
  app.server.extensions.unshift(async (req, res, path) => {
    if (!/^\/chunks\/[a-zA-Z0-9_.-]+$/.test(path)) return false;
    try { const body = await readFile(`${getDistDir()}${path}`); res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }); res.end(body); } catch { res.writeHead(404).end(); }
    return true;
  });
  await app.page.reload();
}

const withTheme = async (app: App, theme: "light" | "dark"): Promise<void> => {
  await app.page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
};

function shot(name: string, route: string, prep: (app: App) => void | Promise<void>, ready: (page: Page) => Promise<void>): Shot {
  return {
    name,
    run: async (theme, width, file) => {
      await withApp({ width, height: width < 800 ? 900 : 1000, colorScheme: theme }, async (app) => {
        await serveChunks(app);
        await prep(app);
        await openRoute(app.page, route);
        await withTheme(app, theme);
        await ready(app.page);
        await settle(app.page, file);
      });
    },
  };
}

const SHOTS: Shot[] = [
  {
    name: "chat",
    run: async (theme, width, file) => {
      await withApp({ width, height: width < 800 ? 900 : 1000, colorScheme: theme, hash: "#/chat/ses_1" }, async (app) => {
        await serveChunks(app);
        const chat = new FakeChat(app.server); chat.install(); seedChat(chat);
        await stubAgents(app.page, AGENTS);
        await signIn(app.page);
        await app.page.locator(".sidebar").waitFor();
        await withTheme(app, theme);
        await app.page.locator(".msg").first().waitFor();
        await settle(app.page, file);
      });
    },
  },
  shot("memories", "#/memories", (app) => { installMemoryMocks(app.server, defaultFixture()); }, async (p) => {
    await p.getByRole("tab", { name: /Memories/ }).first().waitFor();
    await p.locator(".ld-list li").first().waitFor();
    await p.locator(".ld-list li a").first().click();
    await p.locator(".ld-detail .card, .ld-detail p").first().waitFor();
  }),
  shot("dreams", "#/memories/dreams/run_003", (app) => { installMemoryMocks(app.server, defaultFixture()); }, async (p) => {
    await p.locator(".ld-detail").waitFor();
    await p.waitForTimeout(300);
  }),
  shot("models", "#/models", (app) => { seedModels(app.server.rpc); }, async (p) => {
    await p.locator(".ld-list a").first().waitFor();
    await p.locator(".ld-list a").first().click();
    await p.locator("dl.facts").first().waitFor();
  }),
  shot("usage", "#/usage", (app) => { seedBudget(app.server.rpc); }, async (p) => { await p.getByRole("tab").first().waitFor(); await p.locator("meter").first().waitFor(); }),
  {
    name: "doctor",
    run: async (theme, width, file) => {
      await withApp({ width, height: width < 800 ? 900 : 1000, colorScheme: theme, hash: "#/doctor" }, async (app) => {
        await serveChunks(app);
        const m = new DoctorMock(app.server, { core: CORE_OK });
        m.health = { status: 200, body: HEALTH_DEGRADED }; m.agents = { status: 200, body: DOCTOR_AGENTS };
        await signIn(app.page);
        await app.page.getByRole("heading", { name: "Doctor", level: 1 }).waitFor();
        await withTheme(app, theme);
        await app.page.locator("[data-banner]").first().waitFor();
        await app.page.waitForTimeout(300);
        await settle(app.page, file);
      });
    },
  },
  {
    name: "palette-geöffnet",
    run: async (theme, width, file) => {
      await withApp({ width, height: width < 800 ? 900 : 1000, colorScheme: theme }, async (app) => {
        await serveChunks(app);
        const chat = new FakeChat(app.server); chat.install(); seedChat(chat);
        await stubAgents(app.page, AGENTS);
        await signIn(app.page);
        await app.page.locator(".sidebar").waitFor();
        await withTheme(app, theme);
        const mod = await app.page.evaluate(() => (/mac|iphone|ipad/i.test(navigator.platform) ? "Meta" : "Control"));
        await app.page.keyboard.press(`${mod}+K`);
        await app.page.locator("dialog.palette [role=combobox]").waitFor();
        await app.page.waitForTimeout(250);
        await app.page.screenshot({ path: file });
      });
    },
  },
];

if (browserSkip) { console.error(browserSkip); process.exit(1); }
const dir = process.env.PLUR1BUS_WEB_SHOTS_DIR;
if (!dir) { console.error("set PLUR1BUS_WEB_SHOTS_DIR"); process.exit(1); }
const only = process.env.PLUR1BUS_WEB_SHOTS_ONLY?.split(",").filter(Boolean);
await mkdir(dir, { recursive: true });
await setup();
let failed = 0;
try {
  for (const s of SHOTS) {
    if (only && !only.some((o) => s.name.startsWith(o))) continue;
    for (const theme of ["light", "dark"] as const) for (const [size, width] of Object.entries(WIDTHS)) {
      const file = join(dir, `${s.name}-${SCHEME[theme]}-${size}.png`);
      try { await s.run(theme, width, file); console.log("ok  ", file); } catch (e) { failed += 1; console.error("FAIL", file, String(e).split("\n")[0]); }
    }
  }
} finally { await teardown(); }
if (CHECK) console.log(findings.length === 0 ? "check: no findings" : `check: ${findings.length} findings\n${findings.join("\n")}`);
process.exit(failed > 0 ? 1 : 0);
