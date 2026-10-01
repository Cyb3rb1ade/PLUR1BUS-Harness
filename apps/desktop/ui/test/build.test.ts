import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("static shell builds with a local external script and no inline execution", async () => {
  const output = await mkdtemp(join(tmpdir(), "p1t-ui-"));
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url)), output]);
    const html = await readFile(join(output, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0][1], /src="\.\/main\.js"/);
    assert.equal(scripts[0][2], "");
    await readFile(join(output, "main.js"));
    assert.doesNotMatch(html, /https?:|onload=|onclick=/i);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
