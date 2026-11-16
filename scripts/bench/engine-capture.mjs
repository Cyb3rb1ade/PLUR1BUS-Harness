// Run against built release binaries and Core. Each engine gets its own fresh home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const facts = [
  "The budget review starts on Thursday at ten.",
  "The spare gate key is in the green toolbox.",
  "Nora will bring the soup to Tuesday's picnic.",
  "The printer in reception takes recycled paper.",
  "The flight to Porto leaves from terminal two.",
  "The replacement cable is stored on shelf seven.",
  "The garden tap uses a three quarter inch fitting.",
  "The maintenance window begins at midnight.",
  "The first draft of the report is due in March.",
  "The garage door is painted pale blue.",
  "The invoice for the workshop is filed under April.",
  "The train for the morning visit leaves from platform six.",
  "The conference room projector takes an HDMI cable.",
  "Jonas will lead the Saturday hike.",
  "The project handbook is on the top shelf.",
  "The winter tires are in storage bay twelve.",
  "The book club meets at the library on Fridays.",
  "The office lights turn off at seven in the evening.",
  "The wool blankets are packed in the striped bag.",
  "The new server is installed in rack nineteen.",
  "The museum tickets can be collected at the east desk.",
  "The quarterly inventory count starts on Monday.",
];

if (process.argv[2] !== "--leg") {
  const results = [];
  for (const engine of ["node", "rust"]) {
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types", fileURLToPath(import.meta.url), "--leg",
    ], {
      env: {
        ...process.env,
        PLUR1BUS_REAL_MODELS: "0",
        PLUR1BUS_ENGINE_IMPL: engine,
        PLUR1BUS_SYSTEM_INTERNALS: "flat-embedder",
      },
      encoding: "utf8",
      timeout: 180_000,
    });
    if (run.status !== 0) throw new Error(`${engine} benchmark failed: ${run.error ?? run.stderr}`);
    results.push(JSON.parse(run.stdout));
  }
  console.log(JSON.stringify({
    platform: process.platform,
    architecture: process.arch,
    rustToNode: results[1].medianMs / results[0].medianMs,
    engines: results,
  }, null, 2));
} else {
  const { ENGINE_IMPL, cli, home, reapHome, startCore, stopCore, waitEngineReady } =
    await import("../../tests/system/helpers.ts");
  const h = home({ modelCache: false });
  let core;
  try {
    cli(h, ["agent", "create", "capture-bench"]);
    cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
    if (ENGINE_IMPL === "rust") {
      cli(h, ["config", "set", "secrets.fileFallback.enabled", "true", "--yes"]);
    }
    core = await startCore(h, ENGINE_IMPL === "rust" ? {
      PLUR1BUS_ALLOW_TEST_INTERNALS: "1",
      PLUR1BUS_SECRETS_KEYRING: "off",
    } : {});
    await waitEngineReady(h, 60_000);
    const times = [];
    for (const fact of facts) {
      const start = performance.now();
      const result = cli(h, [
        "memory", "add", "--agent", "capture-bench", "--session", "s1",
        `Please remember: ${fact}`,
      ]);
      times.push(performance.now() - start);
      assert.ok(result.stored >= 1 && !result.journaled, JSON.stringify(result));
    }
    const samples = times.slice(2);
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = sorted.length / 2;
    console.log(JSON.stringify({
      engine: ENGINE_IMPL,
      warmed: 2,
      medianMs: (sorted[middle - 1] + sorted[middle]) / 2,
      samplesMs: samples,
    }));
  } finally {
    if (core) await stopCore(core);
    await reapHome(h);
    rmSync(h, { recursive: true, force: true });
  }
}
