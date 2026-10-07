// Shared helpers for the setup wizard tests: mock RPC methods and small page helpers.
import type { Page } from "playwright";
import { openRoute, type App } from "./harness.ts";
import type { MockRpc } from "./mock-rpc.ts";

export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function seed(rpc: MockRpc, models: unknown[] | null = [
  { provider: "anthropic", id: "claude-x", displayName: "Claude X", kind: "chat", status: "available" },
  { provider: "anthropic", id: "embed-1", displayName: "Embed 1", kind: "embedding", status: "available" },
  { provider: "local", id: "old", displayName: "Old", kind: "chat", status: "unavailable" },
]): void {
  rpc.handle("config.set", () => ({ applied: true, dryRun: false, changed: [], restart: {}, revision: "r1", restarted: [], durationMs: 1 }));
  if (models) rpc.handle("models.list", () => ({ models, providers: [], newCount: 0, warnings: [] }), { write: false });
  rpc.handle("admin.backup.snapshot", () => ({ id: "plur1bus-20261007-setup", dir: "/home/state/backup-staging/x", storeTarget: "state/lancedb", engine: {}, files: [] }));
}

export const open = (app: App, hash = "#/setup"): Promise<void> => openRoute(app.page, hash);
export const calls = (app: App, method: string): { params: unknown }[] => app.server.rpc.calls.filter((c) => c.method === method) as never;
export const changes = (app: App): { key: string; value: unknown }[][] => calls(app, "config.set").map((c) => (c.params as { changes: { key: string; value: unknown }[] }).changes);

export const stepHeading = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 2, name });
export const next = (page: Page) => page.getByRole("button", { name: /^(Next|Finish)$/ }).click();
export const skip = (page: Page, name = "Skip this step") => page.getByRole("button", { name }).click();

/** Walks account -> persona -> model with valid answers, leaving the page on the Switchboard step. */
export async function toSwitchboard(app: App): Promise<void> {
  const { page } = app;
  await stepHeading(page, "Your account").waitFor();
  await next(page);
  await stepHeading(page, "Name & persona").waitFor();
  await page.getByLabel("Display name").fill("Hal");
  await next(page);
  await stepHeading(page, /Main model/).waitFor();
  await page.getByLabel("Chat model").selectOption("anthropic/claude-x");
  await next(page);
  await stepHeading(page, /Switchboard/).waitFor();
}
