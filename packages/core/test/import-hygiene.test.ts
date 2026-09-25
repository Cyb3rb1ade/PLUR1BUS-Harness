// Import gate (spec criterion 6): the running core process never loads a forbidden host-adapter
// module (see the offender regex below). This starts the built dist/core.js with a
// `node:module` resolve hook (helpers/trace-hooks.mjs) that records every URL Node resolves, and
// asserts the trace contains no offender after the core has started (with the flat embedder /
// null reranker test internals, so no ONNX model download is triggered — R17).
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { layout } from "../src/paths.ts";

const dist = new URL("../dist/core.js", import.meta.url).pathname;
if (!existsSync(dist)) execFileSync("pnpm", ["build"], { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });

it("the core process never loads a forbidden host-adapter module (criterion 6)", async () => {
  const home = mkdtempSync(join(tmpdir(), "p1b-hyg-"));
  const l = layout(home);
  const cfg = defaults();
  cfg.agents.bernd = {};
  cfg.engine = { reranker: { enabled: false } };
  writeFileSync(l.configPath, JSON.stringify(cfg));
  const trace = join(home, "trace.txt");
  writeFileSync(trace, "");
  const child = spawn(
    process.execPath,
    ["--import", new URL("./helpers/trace-loader.mjs", import.meta.url).pathname, dist, "--home", home, "--test-internals", "flat-embedder"],
    { env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TRACE_FILE: trace }, stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((r) => child.stdout.once("data", () => r()));
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  const urls = readFileSync(trace, "utf8").split("\n").filter(Boolean);
  assert.ok(urls.some((u) => u.includes("/engine/create-engine.js")), "engine loaded");
  // The literal path fragments criterion 6 forbids; scripts/lint-hygiene.mjs allow-lists this
  // exact line by path, since it necessarily quotes those same fragments.
  const offenders = urls.filter((u) => /\/adapter\/openclaw\/|\/lib\/host-services\.js|plugin-runtime|openclaw\.plugin/.test(u));
  assert.deepEqual(offenders, []);
});
