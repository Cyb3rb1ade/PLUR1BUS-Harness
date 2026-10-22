import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTests } from "./test-prep.mjs";

// Only the process boundary is synthetic. The fixture is a real child process and each exit
// controls whether preparation continues; no Engine implementation or resolver substitute is used.
function commands(t, failAt = -1) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-test-prep-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = path.join(root, "commands.jsonl");
  writeFileSync(record, "");
  const fixture = path.join(root, "runner.mjs");
  writeFileSync(fixture, `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [record, failAt, ...args] = process.argv.slice(2);
const index = existsSync(record) ? readFileSync(record, "utf8").trim().split("\\n").filter(Boolean).length : 0;
appendFileSync(record, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
process.exit(index === Number(failAt) ? 23 : 0);
`);
  const output = [];
  return {
    root, output,
    run: (kind, args, options) => spawnSync(process.execPath, [fixture, record, String(failAt), kind, ...args], { cwd: options.cwd }),
    log: (message) => output.push(message),
    calls: () => readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

test("prep completes frozen install, generation, build and real-prerequisite checks in the checkout root", async (t) => {
  const fixture = commands(t);
  assert.equal(await prepareTests(fixture), 0);
  const calls = fixture.calls();
  assert.deepEqual(calls.slice(0, 3).map(call => call.args), [
    ["pnpm", "install", "--frozen-lockfile"], ["pnpm", "gen"], ["pnpm", "build"],
  ]);
  assert.equal(calls.length, 6);
  for (const call of calls) assert.equal(call.cwd, fixture.root);
  assert.deepEqual(calls.slice(3).map(call => call.args.at(-2)), ["audit", "core", "engine"]);
  assert.match(fixture.output.join("\n"), /ready/i);
});

for (const [at, stage] of [[0, "install"], [1, "gen"], [2, "build"], [3, "audit"], [4, "core"], [5, "engine"]]) {
  test(`prep stops after failed ${stage}, preserves the nonzero exit, and never claims readiness`, async (t) => {
    const fixture = commands(t, at);
    assert.equal(await prepareTests(fixture), 23);
    assert.equal(fixture.calls().length, at + 1);
    const output = fixture.output.join("\n");
    assert.match(output, new RegExp(stage, "i"));
    assert.doesNotMatch(output, /tests are ready/i);
    if (stage === "install" || stage === "engine") {
      assert.match(output, /private Engine/);
      assert.match(output, /access/i);
      assert.match(output, /cannot run/i);
    }
  });
}

test("prep turns a missing command into an actionable failure", async (t) => {
  const fixture = commands(t);
  fixture.run = () => ({ status: null, error: Object.assign(new Error("pnpm unavailable"), { code: "ENOENT" }) });
  assert.equal(await prepareTests(fixture), 1);
  assert.match(fixture.output.join("\n"), /pnpm unavailable/);
});

test("the prep CLI actually starts the workflow and propagates a private-install failure", (t) => {
  const fixture = commands(t);
  const cli = path.join(fixture.root, "pnpm-fixture.mjs");
  writeFileSync(cli, 'console.log("install boundary:", JSON.stringify(process.argv.slice(2))); process.exit(23);');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./test-prep.mjs", import.meta.url))], {
    env: { ...process.env, npm_execpath: cli }, encoding: "utf8",
  });
  assert.equal(result.status, 23);
  assert.match(result.stdout, /install boundary:.*install.*--frozen-lockfile/);
  assert.match(result.stdout, /private Engine/);
  assert.match(result.stdout, /cannot run/);
  assert.doesNotMatch(result.stdout, /tests are ready/i);
});
