// Generates docs/openapi.json and docs/api-surface.md from the Harness API's route table
// (packages/api/src/routes.ts). `--check` compares instead of writing and exits 1 when either file is stale; CI runs it
// as part of `pnpm docs:check`. Run with `--conditions=source` (the package scripts do) so the workspace imports read
// TypeScript source rather than a possibly stale dist/. The comparison ignores CRLF vs LF.
import { readFileSync, writeFileSync } from "node:fs";
import { buildOpenApi, buildSurfaceMarkdown } from "../packages/api/src/openapi.ts";

const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
const outputs = [
  ["docs/openapi.json", JSON.stringify(buildOpenApi(), null, 2) + "\n"],
  ["docs/api-surface.md", buildSurfaceMarkdown()],
];

let stale = 0;
for (const [file, content] of outputs) {
  const url = new URL(file, root);
  if (check) {
    let current = "";
    try { current = readFileSync(url, "utf8").replace(/\r\n/g, "\n"); } catch { /* missing counts as stale */ }
    if (current !== content) { console.error(`${file} is stale; run pnpm docs:gen`); stale++; }
  } else {
    writeFileSync(url, content);
    console.log(`wrote ${file}`);
  }
}
process.exit(stale ? 1 : 0);
