// Import gate (spec criterion 6): the running core process never loads a forbidden host-adapter
// module (see the offender regex below). This starts the built dist/core.js with a
// `node:module` resolve hook (helpers/trace-loader.mjs) that records every URL Node resolves —
// for both `import()` and CommonJS `require()` — and asserts the trace contains no offender
// after the core has actually reported ready (with the flat embedder / null reranker test
// internals, so no ONNX model download is triggered — R17).
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "@plur1bus/config-schema";
import { layout } from "../src/paths.ts";

const dist = fileURLToPath(new URL("../dist/core.js", import.meta.url));
if (!existsSync(dist)) execFileSync("pnpm", ["build"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit", shell: process.platform === "win32" });

/** Spawns `target` with the trace hook `--import`ed, returns the trace file's resolved URLs after the first stdout line. */
async function traceFirstStdoutLine(target: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ urls: string[]; firstLine: string }> {
  const traceHome = mkdtempSync(join(tmpdir(), "p1b-hyg-"));
  const trace = join(traceHome, "trace.txt");
  writeFileSync(trace, "");
  const child = spawn(
    process.execPath,
    ["--import", new URL("./helpers/trace-loader.mjs", import.meta.url).href, target, ...args],
    { env: { ...env, PLUR1BUS_TRACE_FILE: trace }, stdio: ["ignore", "pipe", "inherit"] },
  );
  const firstLine = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(d.toString())));
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  return { urls: readFileSync(trace, "utf8").split("\n").filter(Boolean), firstLine };
}

it("the core process never loads a forbidden host-adapter module (criterion 6)", async () => {
  const home = mkdtempSync(join(tmpdir(), "p1b-hyg-"));
  const l = layout(home);
  const cfg = defaults();
  cfg.agents.bernd = {};
  cfg.engine = { reranker: { enabled: false } };
  writeFileSync(l.configPath, JSON.stringify(cfg));
  const { urls, firstLine } = await traceFirstStdoutLine(
    dist,
    ["--home", home, "--test-internals", "flat-embedder"],
    { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" },
  );
  // The first line out of dist/core.js is its `{ ready, address, pid }` line (bin.ts); parse and
  // check it rather than assuming any stdout activity means the core is up, so a core that
  // printed something else (or crashed before becoming ready) fails loudly here instead of the
  // test silently asserting against a trace that stopped mid-boot.
  let ready: unknown;
  try {
    ready = JSON.parse(firstLine).ready;
  } catch {
    /* ready stays undefined; the assertion below reports firstLine verbatim */
  }
  assert.equal(ready, true, `expected the core's ready line on stdout, got: ${firstLine}`);
  assert.ok(urls.some((u) => u.includes("/engine/create-engine.js")), "engine loaded");
  // The literal path fragments criterion 6 forbids; scripts/lint-hygiene.mjs allow-lists this
  // exact line by path, since it necessarily quotes those same fragments.
  const offenders = urls.filter((u) => /\/adapter\/openclaw\/|\/lib\/host-services\.js|plugin-runtime|openclaw\.plugin/.test(u));
  assert.deepEqual(offenders, []);
});

it("the trace hook also sees a CommonJS require(), not just import() (the gap register() left)", async () => {
  // The pinned engine reaches at least one module this way: lib/speaker-mapping-store.js calls
  // `createRequire(import.meta.url)("node:sqlite")` at its top level. A plain `node:module`
  // `register()` async loader hook — what helpers/trace-loader.mjs used before this fix — only
  // instruments the ESM `import()` resolution pipeline, so a `require()` reaching a module never
  // otherwise imported would resolve invisibly to it. helpers/cjs-only-target.mjs mirrors that
  // shape (an ESM module pulling in helpers/cjs-only-fixture.cjs through `createRequire`, never
  // through `import`), so this assertion is a direct, minimal proof of the fix: with the old
  // `register()`-based hook this fixture's URL never appears in the trace (verified manually
  // while making this change — see the task report); with `registerHooks()` it does.
  const target = fileURLToPath(new URL("./helpers/cjs-only-target.mjs", import.meta.url));
  const { urls } = await traceFirstStdoutLine(target, [], process.env);
  assert.ok(
    urls.some((u) => u.endsWith("cjs-only-fixture.cjs")),
    `expected the require()-resolved fixture in the trace, got: ${JSON.stringify(urls)}`,
  );
});
