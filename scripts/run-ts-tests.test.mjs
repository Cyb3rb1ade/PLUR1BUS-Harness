import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgs, countTests, guard } from "./run-ts-tests.mjs";

test("buildArgs has no shell-quoted element", () => {
  for (const a of buildArgs()) assert.ok(!/['"]/.test(a), a);
  assert.ok(buildArgs().includes("--filter=!@plur1bus/desktop-ui"));
});

test("countTests sums spec and TAP summaries", () => {
  assert.equal(countTests("ℹ tests 12\nℹ pass 12\n"), 12);
  assert.equal(countTests("ℹ tests 3\n...\n# tests 4\n"), 7);
  assert.equal(countTests("ℹ tests_x 3\n"), 0);
});

test("guard trips on 'No projects matched' even with exit 0", () => {
  assert.match(guard("No projects matched the filters in x", 0), /no projects/);
});

test("guard trips on zero tests, passes otherwise", () => {
  assert.match(guard("nothing\n", 0), /no tests ran/);
  assert.equal(guard("ℹ tests 5\n", 0), null);
});

const root = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(root, "scripts/test-prerequisites.mjs");
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "plur1bus-prerequisites-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(args) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", ...args], { encoding: "utf8" });
}

test("audit preflight fails with the missing workspace dependency and install command", (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, "packages/core/src/audit"), { recursive: true });
  copyFileSync(path.join(root, "packages/core/src/audit/chain.ts"), path.join(dir, "packages/core/src/audit/chain.ts"));
  const result = run([script, "audit", dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /test prerequisites.*audit/is);
  assert.match(result.stderr, /@plur1bus\/module-api/);
  assert.match(result.stderr, /pnpm install --frozen-lockfile/);
  assert.match(result.stderr, /pnpm gen/);
  assert.match(result.stderr, /pnpm test:prep.*T2/);
});

test("core preflight fails before supervision when core dist is absent", (t) => {
  const result = run([script, "core", fixture(t)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packages[\\/]core[\\/]dist[\\/]core\.js/);
  assert.match(result.stderr, /pnpm build/);
  assert.match(result.stderr, /pnpm test:prep.*T2/);
});

for (const [specifier, dynamic] of [["@cyb3rb1ade/plur1bus-memory", false], ["@cyb3rb1ade/plur1bus-memory", true], ["another-missing-test-dependency", false]]) {
  test(`TypeScript runner keeps missing ${specifier} (${dynamic ? "dynamic" : "static"}) fatal with a specific Engine hint only`, (t) => {
    const dir = fixture(t);
    mkdirSync(path.join(dir, "test"));
    writeFileSync(path.join(dir, "test/missing.test.ts"), dynamic
      ? `import test from "node:test"; test("load Engine", async () => { await import(${JSON.stringify(specifier)}); });`
      : `import ${JSON.stringify(specifier)};`);
    const runner = path.join(root, "scripts/test-package.mjs");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.PLUR1BUS_TEST_SHARD;
    delete env.PLUR1BUS_TEST_SHARD_MANIFEST;
    const result = spawnSync(process.execPath, [runner], { cwd: dir, env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /ERR_MODULE_NOT_FOUND/);
    if (specifier === "@cyb3rb1ade/plur1bus-memory") {
      assert.match(output, /private Engine dependency/);
      assert.match(output, /pnpm install --frozen-lockfile/);
      assert.match(output, /pnpm test:prep.*T2/);
    } else {
      assert.doesNotMatch(output, /private Engine dependency|pnpm test:prep/);
    }
  });
}
