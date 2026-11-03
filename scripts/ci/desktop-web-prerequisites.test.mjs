import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8");
function desktopJob(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const start = lines.indexOf("  desktop:");
  assert.ok(start >= 0, "desktop matrix job must exist");
  const next = lines.findIndex((line, index) => index > start && /^  [\w-]+:$/.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join("\n");
}

for (const newline of ["\n", "\r\n"]) {
  test(`desktop API fixtures have built Web assets before UI and native tests (${newline === "\n" ? "LF" : "CRLF"})`, () => {
    const job = desktopJob(workflow.replace(/\r?\n/g, newline));
    const build = job.indexOf('run: pnpm --filter "@plur1bus/web..." build');
    assert.ok(build >= 0, "build the actual Web package and its dependencies");
    for (const gate of ["run: pnpm --filter @plur1bus/desktop-ui test", "run: cargo test --locked --workspace --no-fail-fast"]) {
      const at = job.indexOf(gate);
      assert.ok(at > build, `${gate} must run after the Web build`);
    }
  });
}
