// Benchmarks (spec criterion 8): B1 `--help` p95 < 100 ms, B11 `core.status` roundtrip p95 < 5 ms and B6 prompt-zone
// determinism (0 drifting zone hashes across 2 renders and 2 process starts, ADR-010) are
// gates (exit 1 on a miss); B8 "core ready < 3 s without local models" is advisory (printed, never gating).
// B9 (0 socket/spawn calls during recall assembly) lives in packages/core/test/b9-no-syscalls.test.ts.
// Env: PLUR1BUS_BIN (default target/release/plur1bus); needs packages/core/dist/core.js (pnpm build).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";

const BIN = resolve(process.env.PLUR1BUS_BIN ?? "target/release/plur1bus");
const CORE_JS = resolve(process.env.PLUR1BUS_CORE_JS ?? "packages/core/dist/core.js");
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const gates = [];
const advisory = [];

// B6 (ADR-010 R3): the prompt builder's zone hashes are byte-identical across 2 renders and 2 process starts. The probe
// (packages/core/test/fixtures/prompt-b6-probe.ts) renders the synthetic corpus twice per run; the two process starts run
// under different time zones and locales. Value = number of drifts, so 0 passes. Needs no build and no binary.
{
  const probe = resolve("packages/core/test/fixtures/prompt-b6-probe.ts");
  const run = (env) => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", probe], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "", ...env } });
  let drift = 0;
  try {
    const outs = [run({ TZ: "UTC", LC_ALL: "C" }), run({ TZ: "Pacific/Auckland", LC_ALL: "de_DE.UTF-8" })];
    if (outs[0] !== outs[1]) drift += 1;
    for (const out of outs) for (const runs of Object.values(JSON.parse(out))) if (JSON.stringify(runs[0]) !== JSON.stringify(runs[1])) drift += 1;
  } catch (e) { console.error(`bench: B6 probe failed: ${e?.message ?? e}`); drift += 1; }
  gates.push(["B6 prompt-zone hash drift", drift, 1, "renders x process starts"]);
}

// B1: --help p95 < 100 ms (50 timed runs after 3 untimed warm-ups for the page cache).
for (let i = 0; i < 3; i += 1) execFileSync(BIN, ["--help"], { stdio: "ignore" });
const b1 = [];
for (let i = 0; i < 50; i += 1) { const t = performance.now(); execFileSync(BIN, ["--help"], { stdio: "ignore" }); b1.push(performance.now() - t); }
gates.push(["B1 --help p95 ms", p95(b1), 100, `median ${median(b1).toFixed(2)}`]);

// B8 (advisory) + B11: a core started by the CLI (`core run`) with the R17 flat-embedder seam, so no model loads.
const home = mkdtempSync(join(tmpdir(), "p1b-bench-"));
const cfg = defaults(); cfg.agents.bernd = {};
writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
const t0 = performance.now();
const core = spawn(BIN, ["--home", home, "core", "run"], {
  env: { ...process.env, PLUR1BUS_CORE_JS: CORE_JS, PLUR1BUS_NODE: process.execPath, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder" },
  stdio: ["ignore", "pipe", "inherit"],
});
// A spawn failure (e.g. a missing binary) emits 'error' and never 'exit': settle both waits on it.
let spawnError = null;
const coreExited = new Promise((r) => { core.once("exit", r); core.once("error", (e) => { spawnError = e; r(); }); });
let failed = 0;
try {
  const ready = await new Promise((res, rej) => {
    core.once("error", (e) => rej(new Error(`core spawn failed: ${e.message}`)));
    let buf = "";
    const onData = (d) => {
      buf += String(d); const nl = buf.indexOf("\n"); if (nl < 0) return;
      core.stdout.off("data", onData);
      try { res(JSON.parse(buf.slice(0, nl))); } catch (e) { rej(new Error(`bad ready line: ${buf.slice(0, nl)} (${e})`)); }
    };
    core.stdout.on("data", onData);
    core.once("exit", (c, s) => rej(new Error(`core exited before ready: code ${c} signal ${s}`)));
  });
  core.stdout.resume();
  advisory.push(["B8 core ready ms (no local models)", performance.now() - t0, 3000, ""]);

  const c = await connect({ address: ready.address, token: readFileSync(join(home, "run/core.token"), "utf8").trim() });
  for (let i = 0; i < 20; i += 1) await c.call("core.status"); // warm-up
  const b11 = [];
  for (let i = 0; i < 200; i += 1) { const t = performance.now(); await c.call("core.status"); b11.push(performance.now() - t); }
  gates.push(["B11 core.status p95 ms", p95(b11), 5, `median ${median(b11).toFixed(3)}`]);
  await c.close();
} catch (e) {
  console.error(`bench: ${e?.stack ?? e}`);
  failed += 1;
} finally {
  if (!spawnError && core.exitCode === null && core.signalCode === null) core.kill("SIGTERM");
  await coreExited;
  rmSync(home, { recursive: true, force: true });
}

for (const [name, value, limit, extra] of gates) {
  const ok = value < limit;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${value.toFixed(2)} (limit ${limit}${extra ? `; ${extra}` : ""})`);
  if (!ok) failed += 1;
}
for (const [name, value, limit] of advisory) console.log(`${value < limit ? "OK  " : "SLOW"} ${name}: ${value.toFixed(0)} (advisory, target ${limit})`);
process.exit(failed ? 1 : 0);
