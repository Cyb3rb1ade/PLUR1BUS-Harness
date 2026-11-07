import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { withShell } from "./browser-harness.ts";

// #740 Home chip (owner decision 2026-11-07, proposal 1).
const running = { harness: "ready", runtime: null, secretsLocked: false, updateAvailable: false, held: false, path: null, transportAttention: false, tailscaleNotice: false, approvalsPending: false, badge: "running", connectionName: "Studio", connectionKind: "remote" };
type Shown = { label: string | null; title: string; badge: string | undefined; tone: string; path: string | null; icon: string | null | undefined };

async function emit(page: Page, view: Record<string, unknown>): Promise<Shown> {
  await page.evaluate(view => (window as any).testShell.emitTray(view), view);
  return shown(page);
}
async function shown(page: Page): Promise<Shown> {
  return page.evaluate(() => {
    const chip = document.querySelector<HTMLButtonElement>(".home-hero .connection-chip")!;
    return {
      label: chip.getAttribute("aria-label"), title: chip.title, badge: chip.dataset.badge,
      tone: ["ok", "warning", "neutral"].find(tone => chip.classList.contains(`chip-${tone}`)) ?? "",
      path: chip.querySelector(".chip-path")?.textContent ?? null,
      icon: chip.querySelector("svg path")?.getAttribute("d"),
    };
  });
}

test("the Home chip shows the tray's connection, badge and word, with the path in the tooltip", async () => {
  await withShell(async page => {
    await page.waitForFunction(() => document.querySelector(".connection-chip")?.getAttribute("data-badge") === "attention");
    let chip = await shown(page);
    assert.deepEqual([chip.label, chip.badge, chip.tone, chip.path], ["No connection, Not paired", "attention", "warning", null], "a fresh tray never reads Ready");
    chip = await emit(page, { ...running, path: "tailscale" });
    assert.deepEqual([chip.label, chip.title, chip.badge, chip.tone, chip.path], ["Studio, Running, Tailscale", "Tailscale · View connections", "running", "ok", null]);
    assert.ok(chip.icon?.startsWith("M3 4h12v6H3z"), "a remote connection shows the server glyph");
    chip = await emit(page, { ...running, path: "direct-public" });
    assert.deepEqual([chip.label, chip.badge, chip.tone, chip.path], ["Studio, Running, Direct · public", "running", "warning", "Direct · public"], "a public direct path is shown in amber");
    chip = await emit(page, { ...running, path: "tailscale", tailscaleNotice: true, transportAttention: true, badge: "attention" });
    assert.deepEqual([chip.label, chip.tone, chip.path], ["Studio, Running, Tailscale disconnected", "warning", "Tailscale disconnected"]);
    chip = await emit(page, { ...running, harness: "disconnected", badge: "attention", path: "direct" });
    assert.deepEqual([chip.label, chip.title, chip.tone, chip.path], ["Studio, Not connected, Direct", "Direct · View connections", "warning", null]);
    chip = await emit(page, { ...running, approvalsPending: true, secretsLocked: true, badge: "attention", connectionName: "Box", connectionKind: "bundled" });
    assert.deepEqual([chip.label, chip.title, chip.tone], ["Box, Running", "A request is waiting for approval · Secrets store locked · View connections", "warning"], "the reasons for attention stay in the tooltip");
    assert.ok(chip.icon?.startsWith("M3 4h18v12H3z"), "a bundled connection shows the screen glyph");
    chip = await emit(page, { ...running, harness: "updating", badge: "busy" });
    assert.deepEqual([chip.label, chip.badge, chip.tone], ["Studio, Updating", "busy", "neutral"]);
    await page.evaluate(() => (window as any).testShell.setPreferences({ locale: "de" }));
    chip = await emit(page, { ...running, harness: "disconnected", badge: "attention", path: "direct" });
    assert.deepEqual([chip.label, chip.title], ["Studio, Nicht verbunden, Direkt", "Direkt · Verbindungen ansehen"]);
    await page.locator(".home-hero .connection-chip").click();
    await page.waitForFunction(() => document.documentElement.dataset.section === "connections");
  });
});

test("without a tray view the Home chip claims no state", async () => {
  await withShell(async page => {
    const chip = await shown(page);
    assert.deepEqual([chip.label, chip.badge, chip.tone], ["No connection, Status unknown", "unknown", "neutral"]);
  }, undefined, { tray: null });
});
