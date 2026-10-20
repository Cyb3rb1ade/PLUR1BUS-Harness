import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("required browser mode refuses missing pinned Chromium even when an override exists", () => {
  const emptyBrowsers = mkdtempSync(join(tmpdir(), "m3-web-browser-required-"));
  try {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--input-type=module", "-e", `await import(${JSON.stringify(new URL("./harness.ts", import.meta.url).href)})`], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers, PLUR1BUS_WEB_E2E_REQUIRED: "1", PLUR1BUS_CHROMIUM: process.execPath },
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(r.status, 1, `missing lockfile-matched browser must fail: ${r.stderr}`);
    assert.match(r.stderr, /PLUR1BUS_WEB_E2E_REQUIRED=1 but no Chromium was found/);
  } finally { rmSync(emptyBrowsers, { recursive: true, force: true }); }
});

// The explicit switch the macOS unit job uses (the browser suites run in the `web-browser (macos-15)` job instead).
function harnessSkipReason(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--input-type=module", "-e", `const h = await import(${JSON.stringify(new URL("./harness.ts", import.meta.url).href)}); console.log(JSON.stringify(h.browserSkip))`], {
    env: { ...process.env, PLUR1BUS_WEB_BROWSER: "", PLUR1BUS_WEB_E2E_REQUIRED: "", ...env },
    encoding: "utf8", timeout: 15_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("PLUR1BUS_WEB_BROWSER=off skips the browser suites with a reason, even when a Chromium is available", () => {
  const r = harnessSkipReason({ PLUR1BUS_WEB_BROWSER: "off", PLUR1BUS_CHROMIUM: process.execPath });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout.trim()) as string, /PLUR1BUS_WEB_BROWSER=off/);
});

test("without the switch an available Chromium is used (the switch is opt-in, nothing else turns the suites off)", () => {
  const r = harnessSkipReason({ PLUR1BUS_CHROMIUM: process.execPath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()), false);
});

test("PLUR1BUS_WEB_BROWSER=off together with PLUR1BUS_WEB_E2E_REQUIRED=1 is a failure, not a silent skip", () => {
  const r = harnessSkipReason({ PLUR1BUS_WEB_BROWSER: "off", PLUR1BUS_WEB_E2E_REQUIRED: "1" });
  assert.equal(r.status, 1, "required mode must not be switchable off");
  assert.match(r.stderr, /PLUR1BUS_WEB_BROWSER=off conflicts with PLUR1BUS_WEB_E2E_REQUIRED=1/);
});
