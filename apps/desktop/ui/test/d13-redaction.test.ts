// Audit D13 (apps/desktop/ui): written red first; the fix is in the same commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
import { redactDiagnostics } from "../src/models/redact.ts";
// Secret-shaped values are assembled at run time so no token-like literal sits in the source.
const secretValue = () => "Ab1".repeat(14);

test("redactDiagnostics masks home paths, bearer values, key=value secrets, URL userinfo and long opaque runs", () => {
  const value = secretValue();
  const text = [
    "open /Users/alice/Library/Logs/x.log", "read /home/bob/.config/p1", "read C:\\Users\\carol\\AppData\\Local\\p1",
    `Authorization: Bearer ${value}`, `access_token=${value}`, `fetch https://svc:${value}@harness.test/api`, `opaque ${value}${value}`,
    "sha256:" + "a1".repeat(32), "exit code: 1", "tokenHint=abcd",
  ].join("\n");
  const out = redactDiagnostics(text);
  for (const leaked of ["alice", "bob", "carol", value]) assert.ok(!out.includes(leaked), `leaked ${leaked}`);
  assert.ok(out.includes("sha256:" + "a1".repeat(32)), "image digests stay readable");
  assert.ok(out.includes("exit code: 1"));
  assert.ok(out.includes("harness.test/api"));
});

test("diagnostic views show and copy redacted text only", async () => {
  await withShell(async page => {
    const value = secretValue();
    const raw = `crash in /Users/alice/Library/p1 Authorization: Bearer ${value}`;
    await page.addInitScript(log => { (window as any).__fixtureBoot = { bundled: true, runtimeLog: log }; }, raw);
    await page.reload();
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).testShell.navigate("settings", "runtime"));
    await page.getByRole("button", { name: "Show redacted logs" }).click();
    const log = await page.locator(".runtime-log").textContent();
    assert.ok(log && !log.includes("alice") && !log.includes(value), "runtime log");
    await page.evaluate(text => (window as any).testShell.openCrashText(text), raw);
    const details = await page.locator(".crash-details").textContent();
    assert.ok(details && !details.includes("alice") && !details.includes(value), "crash details");
    await page.getByRole("button", { name: "Copy details" }).click();
    const copied = await page.evaluate(() => (window as any).testShell.crashCopied.join("\n"));
    assert.ok(!copied.includes("alice") && !copied.includes(value), "copied crash details");
    await page.evaluate(text => (window as any).testShell.showProgress("recoveryFailed", { state: "recoveryFailed", diagnostic: text }), raw);
    const diag = await page.locator(".diagnostic-details").textContent();
    assert.ok(diag && !diag.includes("alice") && !diag.includes(value), "upgrade diagnostic");
  });
});
