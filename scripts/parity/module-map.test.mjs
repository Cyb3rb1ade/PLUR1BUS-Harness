import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DISPOSITIONS, MODES, OUTPUT, OWNERS, SRC_RULES, SYSTEM_SUITES, TEST_RULES, build, classifyKind, classifySrc, classifyTest, generate, listFiles, render, systemSuites } from "./module-map.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("the committed MODULE-MAP.md is exactly what the rules generate (regenerate: node scripts/parity/module-map.mjs)", () => {
  assert.equal(readFileSync(`${ROOT}${OUTPUT}`, "utf8"), generate(ROOT));
});

test("every non-UI src and test file appears exactly once, and the web package is out of scope", () => {
  const files = listFiles(ROOT);
  const map = build(ROOT, files);
  assert.equal(files.some((f) => f.startsWith("packages/web/")), false);
  const seen = [...map.src, ...map.tests, ...map.other].map((r) => r.path);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...seen].sort(), files);
  assert.ok(map.src.length > 1100 && map.tests.length > 1500, `src ${map.src.length}, tests ${map.tests.length}`);
  const text = render(map, systemSuites(ROOT));
  for (const f of files) assert.ok(text.includes(`\`${f}\``), f);
});

test("every rule matches at least one file, so the table has no dead or shadowed row", () => {
  const files = listFiles(ROOT);
  const map = build(ROOT, files);
  const usedSrc = new Set(map.src.map((r) => r.rule)), usedTest = new Set(map.tests.map((r) => r.rule));
  SRC_RULES.forEach(([re], i) => assert.ok(usedSrc.has(i), `SRC_RULES[${i}] ${re} wins for no file`));
  TEST_RULES.forEach(([re], i) => assert.ok(usedTest.has(i), `TEST_RULES[${i}] ${re} wins for no file`));
});

test("owners, dispositions and modes are from the closed vocabularies", () => {
  for (const [, owner, disp] of SRC_RULES) { assert.ok(owner in OWNERS, owner); assert.ok(disp in DISPOSITIONS && disp !== "unassigned", disp); }
  for (const [, owner, modes] of TEST_RULES) {
    assert.ok(owner in OWNERS || owner === "unassigned" || owner === "P4-6x", owner);
    for (const m of modes.split(",").filter(Boolean)) assert.ok(m in MODES, m);
  }
  for (const [, owner] of SYSTEM_SUITES) assert.ok(owner in OWNERS, owner);
  for (const r of build(ROOT).tests) if (!r.modes) assert.ok(r.reason.length > 10, `${r.path} has neither a mode nor a reason`);
});

test("the first matching rule wins", () => {
  assert.deepEqual(pick("packages/core/src/tools/mcp-bridge.ts"), ["P4-70", "port"]);
  assert.deepEqual(pick("packages/core/src/tools/dispatcher.ts"), ["P4-43", "port"]);
  assert.deepEqual(pick("packages/core/src/tools/exec/run.ts"), ["P4-30", "port"]);
  assert.deepEqual(pick("packages/core/src/session/turn-loop.ts"), ["P4-43", "port"]);
  assert.deepEqual(pick("packages/core/src/session/store.ts"), ["P4-40", "port"]);
  assert.deepEqual(pick("packages/core/src/toolcall/turn-eval.ts"), ["P4-91", "stays-TS"]);
  assert.deepEqual(pick("packages/core/src/toolcall/stable-tools.ts"), ["P4-42", "port"]);
  assert.deepEqual(pick("packages/api/src/oauth/store.ts"), ["P4-80b", "stays-TS"]);
  assert.deepEqual(pick("packages/module-api/src/client.ts"), ["—", "stays-TS"]);
  assert.deepEqual(pick("packages/module-api/src/rpc-server.ts"), ["P4-10", "stays-TS"]);
  assert.equal(classifyTest("packages/channels-matrix/test/x.test.ts").owner, "P4-65");
  assert.equal(classifyTest("packages/core/test/rpc/x.test.ts").modes, "T");
});

test("a file no rule matches is listed as unassigned, never guessed", () => {
  assert.deepEqual(pick("packages/core/src/brand-new-module.ts"), ["unassigned", "unassigned"]);
  assert.equal(classifyTest("packages/core/test/brand-new.test.ts").owner, "unassigned");
  const text = render({ src: [{ path: "packages/core/src/brand-new-module.ts", lines: 3, ...classifySrc("packages/core/src/brand-new-module.ts") }], tests: [], other: [] }, []);
  assert.match(text, /## Unassigned\n\n1 source files/);
  assert.match(text, /\| `packages\/core\/src\/brand-new-module\.ts` \| 3 \|/);
});

test("file kinds", () => {
  assert.equal(classifyKind("packages/core/src/core.ts"), "src");
  assert.equal(classifyKind("packages/core/test/core.test.ts"), "test");
  assert.equal(classifyKind("packages/core/test/helpers/abs.ts"), "test");
  assert.equal(classifyKind("packages/x/src/a.test.ts"), "test");
  assert.equal(classifyKind("packages/core/bench/rewind-checkpoints.ts"), "other");
});

test("every tests/system suite has an owner entry", () => {
  const unknown = systemSuites(ROOT).filter((s) => s.owner === "unassigned");
  assert.deepEqual(unknown, []);
  for (const [name] of SYSTEM_SUITES) assert.ok(systemSuites(ROOT).some((s) => s.name === name), `${name} is not a suite`);
});

function pick(path) { const r = classifySrc(path); return [r.owner, r.disp]; }
