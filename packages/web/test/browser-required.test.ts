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
