// Optional stack smoke for local builds; force with PLUR1BUS_WEB_TRANSPORT_REQUIRED=1. Uses no HTTP/RPC mocks.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { findChromium } from "./browser-runtime.ts";
import { defaults } from "@plur1bus/config-schema";
import { buildWeb } from "../build.ts";
import { createApiServer } from "../../api/src/server.ts";
import { createCoreLink } from "../../api/src/core-link.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = resolve(process.env.PLUR1BUS_BIN ?? join(root, "target/debug/plur1bus"));
const coreJs = join(root, "packages/core/dist/core.js");
const executablePath = findChromium();
const unavailable = !executablePath || !existsSync(bin) || !existsSync(coreJs);
if (unavailable && process.env.PLUR1BUS_WEB_TRANSPORT_REQUIRED === "1") throw new Error("real transport smoke requires a built CLI/core and Chromium");

test("Chromium with real API/Core/Supervisor: Inbox, Chat list, Settings read", { skip: unavailable ? "build CLI/core and install Chromium; force with PLUR1BUS_WEB_TRANSPORT_REQUIRED=1" : false, timeout: 120000 }, async t => {
  const scratch = mkdtempSync(join(tmpdir(), "p1b-browser-real-")), home = join(scratch, "home"), webRoot = join(scratch, "web");
  const { mkdirSync } = await import("node:fs"); mkdirSync(home);
  const cfg = defaults(); cfg.agents.main = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  let daemon = false;
  t.after(() => { if (daemon) execFileSync(bin, ["--home", home, "daemon", "stop"], { timeout: 30000, stdio: "pipe" }); rmSync(scratch, { recursive: true, force: true }); });
  execFileSync(bin, ["--home", home, "daemon", "start"], { timeout: 30000, stdio: "pipe", env: { ...process.env, PLUR1BUS_NODE: process.execPath, PLUR1BUS_CORE_JS: coreJs, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder", PLUR1BUS_TEST_CHAT_PROVIDER: "fake" } }); daemon = true;
  await buildWeb(webRoot);
  const link = createCoreLink(home); const ownerToken = randomBytes(32).toString("hex");
  const api = createApiServer({ core: link, ownerToken, webRoot }); const { url } = await api.listen();
  t.after(async () => { await api.close(); await link.close(); });
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en-US" }); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const answers = new Map<string, any[]>();
  page.on("response", response => { if (!response.url().endsWith("/rpc")) return; void response.json().then(body => { const request = response.request().postDataJSON(); const list = answers.get(request.method) ?? []; list.push(body); answers.set(request.method, list); }).catch(() => {}); });
  await page.goto(url + "/#/login");
  await page.getByLabel("Owner token", { exact: true }).fill(ownerToken); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.page-state[data-state="loading"]'));
  await page.evaluate(() => { location.hash = "#/inbox"; }); await page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
  await page.getByText("Nothing here", { exact: true }).waitFor();
  await page.evaluate(() => { location.hash = "#/settings/general"; }); await page.getByRole("heading", { name: "General", level: 2 }).waitFor();
  await page.locator('.cfg-field[data-key="core.recall.softBudgetMs"]').waitFor();
  for (const method of ["session.list", "inbox.list", "config.get"]) {
    assert.ok(answers.get(method)?.some(answer => "result" in answer && !answer.error), `${method} succeeded over real /rpc`);
  }
  assert.deepEqual(errors, []);
  assert.ok(!(await page.evaluate(() => document.cookie)).includes("plur1bus_session"));
});
