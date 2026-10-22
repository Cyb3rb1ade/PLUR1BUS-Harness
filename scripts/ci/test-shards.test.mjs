import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShard, selectShard, verifyManifests, listTestFiles, writeManifest } from "./test-shards.mjs";

const files = Array.from({ length: 23 }, (_, i) => `test/f${String(i).padStart(2, "0")}.test.ts`);

test("parseShard accepts i/N and refuses everything else", () => {
  assert.deepEqual(parseShard("1/4"), { index: 1, total: 4 });
  assert.deepEqual(parseShard("4/4"), { index: 4, total: 4 });
  for (const bad of ["0/4", "5/4", "1/0", "a/4", "1/4/2", "", " 1/4", "1.5/4", "-1/4", "01/4"]) assert.throws(() => parseShard(bad), /shard/);
});

test("every file lands in exactly one shard, for any shard count", () => {
  for (let total = 1; total <= 8; total++) {
    const seen = new Map();
    for (let index = 1; index <= total; index++) for (const f of selectShard(files, { index, total })) seen.set(f, (seen.get(f) ?? 0) + 1);
    assert.deepEqual([...seen.keys()].sort(), [...files].sort(), `total ${total}: union`);
    assert.ok([...seen.values()].every(n => n === 1), `total ${total}: disjoint`);
  }
});

test("distribution is deterministic and independent of input order", () => {
  const shuffled = [...files].reverse();
  for (let index = 1; index <= 4; index++) assert.deepEqual(selectShard(shuffled, { index, total: 4 }), selectShard(files, { index, total: 4 }));
  // Round-robin over the sorted list: shard sizes differ by at most one.
  const sizes = [1, 2, 3, 4].map(index => selectShard(files, { index, total: 4 }).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, String(sizes));
});

test("verifyManifests accepts a complete partition", () => {
  const manifests = [1, 2, 3, 4].map(index => ({ shard: index, total: 4, files: selectShard(files, { index, total: 4 }) }));
  assert.deepEqual(verifyManifests(manifests, files), []);
});

test("verifyManifests reports a lost shard, a lost file, a duplicate, a foreign file and a mixed total", () => {
  const ok = () => [1, 2, 3, 4].map(index => ({ shard: index, total: 4, files: selectShard(files, { index, total: 4 }) }));
  const missingShard = ok().slice(0, 3);
  assert.ok(verifyManifests(missingShard, files).some(e => /shard 4\/4 missing/.test(e)));
  const lostFile = ok(); lostFile[0].files = lostFile[0].files.slice(1);
  assert.ok(verifyManifests(lostFile, files).some(e => /not run by any shard: test\/f00/.test(e)));
  const dup = ok(); dup[1].files = [...dup[1].files, dup[0].files[0]];
  assert.ok(verifyManifests(dup, files).some(e => /more than one shard/.test(e)));
  const foreign = ok(); foreign[2].files = [...foreign[2].files, "test/gone.test.ts"];
  assert.ok(verifyManifests(foreign, files).some(e => /not in the test list/.test(e)));
  const mixed = ok(); mixed[3].total = 5;
  assert.ok(verifyManifests(mixed, files).some(e => /disagree on the shard count/.test(e)));
  const twice = [...ok(), ok()[0]];
  assert.ok(verifyManifests(twice, files).some(e => /shard 1\/4 reported twice/.test(e)));
  const empty = ok(); empty[0].files = [];
  assert.ok(verifyManifests(empty, files).some(e => /shard 1\/4 ran no test file/.test(e)));
  assert.ok(verifyManifests([], files).some(e => /no shard manifests/.test(e)));
});

test("CLI verify reads the manifests a sharded test-package run wrote and fails on a gap", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const pkg = mkdtempSync(join(tmpdir(), "p1-shards-"));
  try {
    mkdirSync(join(pkg, "test", "sub"), { recursive: true });
    for (const f of ["a", "b", "c", "sub/d", "e"]) writeFileSync(join(pkg, "test", `${f}.test.ts`), "import { test } from 'node:test'; test('x', () => {});\n");
    writeFileSync(join(pkg, "test", "helper.ts"), "export {};\n");
    const all = listTestFiles(pkg);
    assert.deepEqual(all, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/e.test.ts", "test/sub/d.test.ts"]);
    const dir = join(pkg, "manifests");
    mkdirSync(dir);
    // The real writer: test-package.mjs with the shard environment, run in the package directory.
    for (const index of [1, 2, 3]) {
      const r = spawnSync(process.execPath, [join(root, "scripts/test-package.mjs")], { cwd: pkg, encoding: "utf8", env: { ...process.env, PLUR1BUS_TEST_SHARD: `${index}/3`, PLUR1BUS_TEST_SHARD_MANIFEST: join(dir, `shard-${index}.json`), NODE_OPTIONS: "" } });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    }
    const ran = [1, 2, 3].flatMap(i => JSON.parse(readFileSync(join(dir, `shard-${i}.json`), "utf8")).files);
    assert.deepEqual(ran.sort(), all);
    const cli = (...args) => spawnSync(process.execPath, [join(root, "scripts/ci/test-shards.mjs"), ...args], { encoding: "utf8" });
    const good = cli("verify", `--cwd=${pkg}`, `--dir=${dir}`);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /5 test files, 3 shards, each file exactly once/);
    rmSync(join(dir, "shard-2.json"));
    const bad = cli("verify", `--cwd=${pkg}`, `--dir=${dir}`);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /shard 2\/3 missing/);
    // A malformed shard variable must not silently run every file.
    const r = spawnSync(process.execPath, [join(root, "scripts/test-package.mjs")], { cwd: pkg, encoding: "utf8", env: { ...process.env, PLUR1BUS_TEST_SHARD: "4/3", NODE_OPTIONS: "" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /shard/);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("writeManifest records shard, total and files", () => {
  const dir = mkdtempSync(join(tmpdir(), "p1-manifest-"));
  try {
    const path = join(dir, "m.json");
    writeManifest(path, { index: 2, total: 4 }, ["test/x.test.ts"]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { shard: 2, total: 4, files: ["test/x.test.ts"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("measured durations put the longest files first on the least-loaded shard", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const durations = { "test/a.test.ts": 9000, "test/b.test.ts": 8000, "test/c.test.ts": 2000, "test/d.test.ts": 1000 };
  assert.deepEqual(selectShard(files, { index: 1, total: 2 }, durations), ["test/a.test.ts", "test/d.test.ts"]);
  assert.deepEqual(selectShard(files, { index: 2, total: 2 }, durations), ["test/b.test.ts", "test/c.test.ts"]);
});

test("timed sharding remains an exact stable partition when files are added, removed or unmeasured", () => {
  const files = ["test/new.test.ts", "test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const durations = { "test/a.test.ts": 10000, "test/b.test.ts": 5000, "test/removed.test.ts": 20000 };
  for (const total of [2, 3, 4]) {
    const manifests = Array.from({ length: total }, (_, i) => ({ shard: i + 1, total, files: selectShard(files, { index: i + 1, total }, durations) }));
    assert.deepEqual(verifyManifests(manifests, files), []);
    for (const manifest of manifests) assert.deepEqual(manifest.files, selectShard([...files].reverse(), { index: manifest.shard, total }, durations));
  }
});

test("invalid timing data cannot silently change the executed partition", () => {
  for (const bad of [[], null, { a: -1 }, { a: Infinity }, { a: "1000" }, { a: NaN }]) {
    assert.throws(() => selectShard(["a", "b"], { index: 1, total: 2 }, bad), /timing/);
  }
});

test("test-package executes the measured subset and records its manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "p1b-timed-shard-"));
  try {
    mkdirSync(join(root, "test"));
    const executed = join(root, "executed.txt");
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(root, "test", `${name}.test.ts`), `import { test } from 'node:test'; import { appendFileSync } from 'node:fs'; test('run-${name}', () => appendFileSync(${JSON.stringify(executed)}, '${name}\\n'));\n`);
    const profile = join(root, "timings.json"), manifest = join(root, "manifest.json");
    writeFileSync(profile, JSON.stringify({ version: 1, durationsMs: { "test/a.test.ts": 9000, "test/b.test.ts": 8000, "test/c.test.ts": 2000, "test/d.test.ts": 1000 } }));
    const runner = fileURLToPath(new URL("../test-package.mjs", import.meta.url));
    const env = { ...process.env, NODE_OPTIONS: "", PLUR1BUS_TEST_SHARD: "1/2", PLUR1BUS_TEST_SHARD_TIMINGS: profile, PLUR1BUS_TEST_SHARD_MANIFEST: manifest };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")).files, ["test/a.test.ts", "test/d.test.ts"]);
    assert.deepEqual(readFileSync(executed, "utf8").trim().split("\n").sort(), ["a", "d"]);
    writeFileSync(profile, JSON.stringify({ version: 99, durationsMs: {} }));
    const invalid = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(invalid.status, 0, "unrecognized timing data must stop execution");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the committed Core timing profile partitions the live file inventory and rejects a missing shard", () => {
  const profile = JSON.parse(readFileSync(new URL("../../.github/ci/core-test-timings.json", import.meta.url), "utf8"));
  const all = listTestFiles(fileURLToPath(new URL("../../packages/core", import.meta.url)));
  const manifests = [1, 2, 3].map(index => ({ shard: index, total: 3, files: selectShard(all, { index, total: 3 }, profile.durationsMs) }));
  assert.deepEqual(verifyManifests(manifests, all), []);
  assert.ok(verifyManifests(manifests.slice(0, 2), all).some(error => error.includes("shard 3/3 missing")));
  const duplicate = manifests.map(m => ({ ...m, files: [...m.files] }));
  duplicate[1].files.push(manifests[0].files[0]);
  assert.ok(verifyManifests(duplicate, all).some(error => error.includes("more than one shard")));
});
