// Audit D13 (apps/desktop/ui): written red first; the fix is in the same commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
import { translate, type MessageKey } from "../src/i18n.ts";

test("translate never throws for a key the catalogue lacks (native state strings reach it)", () => {
  assert.doesNotThrow(() => translate("en", "runtime.status.hibernating" as MessageKey));
  assert.doesNotThrow(() => translate("de", "runtime.status.hibernating" as MessageKey));
});

test("wizard install proceeds when the progress listener cannot be registered", async () => {
  await withShell(async page => {
    await page.addInitScript(() => { (window as any).__fixtureBoot = { bundled: true, failProgress: true }; });
    await page.reload();
    await page.getByRole("button", { name: "Set up a local harness", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("checkbox", { name: "I agree to the licences" }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("radio").waitFor();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Open PLUR1BUS", exact: true }).waitFor({ timeout: 3000 });
  });
});

test("runtime settings survive a harness state string the catalogue does not know", async () => {
  await withShell(async page => {
    await page.addInitScript(() => { (window as any).__fixtureBoot = { bundled: true, harnessState: "hibernating" }; });
    await page.reload();
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).testShell.navigate("settings", "runtime"));
    await page.getByText("Status not checked", { exact: true }).waitFor({ timeout: 3000 });
  });
});
