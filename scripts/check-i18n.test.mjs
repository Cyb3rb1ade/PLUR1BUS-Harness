// Unit tests for scripts/check-i18n.mjs (run by `pnpm lint`). Every case builds its own tree in a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkI18n, placeholders, stripComments } from "./check-i18n.mjs";

const script = fileURLToPath(new URL("./check-i18n.mjs", import.meta.url));
const CAT = "ui/i18n";
const surface = { name: "t", catalogueDir: CAT, sourceDirs: ["ui/src"] };

function tree(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "p1b-i18n-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const p = join(root, ...rel.split("/"));
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, typeof text === "string" ? text : JSON.stringify(text));
    }
    return fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const base = (extra = {}) => ({
  [`${CAT}/en.json`]: { "a.title": "Hello {name}", "a.body": "Body" },
  [`${CAT}/de.json`]: { "a.title": "Hallo {name}", "a.body": "Inhalt" },
  "ui/src/main.ts": 't("a.title"); t("a.body");',
  ...extra,
});
const run = (files, config = {}) => tree(files, (root) => checkI18n({ root, config: { surfaces: [surface], ...config } }));
const kinds = (fs) => fs.map((f) => f.kind).sort();

test("a complete, referenced catalogue pair is clean", () => assert.deepEqual(run(base()), []));

test("missing translation is reported per side", () => {
  const f = run(base({ [`${CAT}/de.json`]: { "a.title": "Hallo {name}" } }));
  assert.deepEqual(kinds(f), ["missing-key"]);
  assert.equal(f[0].key, "a.body");
  const g = run(base({ [`${CAT}/en.json`]: { "a.title": "Hello {name}", "a.body": "B", "a.extra": "x" }, "ui/src/x.ts": 't("a.extra")' }));
  assert.deepEqual(kinds(g), ["missing-key"]);
  assert.match(g[0].file, /de\.json$/);
});

test("blank and non-string messages are rejected", () => {
  const f = run(base({ [`${CAT}/de.json`]: { "a.title": "  ", "a.body": 3 } }));
  assert.deepEqual(kinds(f), ["empty-message", "empty-message"]);
});

test("placeholders must match as multisets", () => {
  assert.deepEqual(placeholders("{b} {a} {a}"), ["a", "a", "b"]);
  const f = run(base({ [`${CAT}/de.json`]: { "a.title": "Hallo {nam}", "a.body": "Inhalt" } }));
  assert.deepEqual(kinds(f), ["placeholder-mismatch"]);
  assert.equal(run(base({ [`${CAT}/de.json`]: { "a.title": "Hallo {name} {name}", "a.body": "I" } })).length, 1);
});

test("dead keys: literal use and template prefixes/suffixes count as use", () => {
  const files = base({
    [`${CAT}/en.json`]: { "a.title": "T {name}", "a.body": "B", "err.net": "N", "err.io": "I", "s.xTitle": "X", "dead.one": "D" },
    [`${CAT}/de.json`]: { "a.title": "T {name}", "a.body": "B", "err.net": "N", "err.io": "I", "s.xTitle": "X", "dead.one": "D" },
    "ui/src/main.ts": 't("a.title"); t("a.body"); t(`err.${code}`); t(`s.${page}Title`); `${bare}`;',
  });
  const f = run(files);
  assert.deepEqual(f.map((x) => x.key), ["dead.one"]);
  assert.equal(f[0].kind, "dead-key");
});

test("a keys mention only inside a comment is not use", () => {
  const f = run(base({ "ui/src/main.ts": '// t("a.body")\nt("a.title");' }));
  assert.deepEqual(f.map((x) => x.key), ["a.body"]);
});

test("hardcoded text heuristics fire, t() calls and class names do not", () => {
  const src = [
    't("a.title"); t("a.body");',
    'const a = element("p", "lead", t("a.body"));',
    'const b = element("p", "lead", "Plain English");',
    'node.textContent = "Saved changes";',
    'node.setAttribute("aria-label", "Close dialog");',
    'x.append(document.createTextNode("Some words"));',
    'const c = de ? "Schließen" : "Dismiss";',
    'node.textContent = "ok-id"; node.className = "button primary"; const d = element("p", "sr-only", "x");',
    '// node.textContent = "In a comment";',
  ].join("\n");
  const f = run(base({ "ui/src/main.ts": src }));
  assert.deepEqual(f.map((x) => x.line).sort(), [3, 4, 5, 6, 7]);
  assert.ok(f.every((x) => x.kind === "hardcoded-text"));
});

test("html text nodes are flagged, script/style content is not", () => {
  const html = '<!doctype html><title>Page</title><style>.a{content:"Hello there"}</style><script>var s="Hello there"</script><p>Visible words</p><button aria-label="Copy it">x</button>';
  const f = run(base({ "ui/src/page.html": html }));
  assert.deepEqual(f.map((x) => x.detail.split(":")[0]).sort(), ["html attribute", "html text node", "html text node"]);
});

test("test files and the catalogue dir itself are not scanned as sources", () => {
  const f = run(base({ "ui/src/main.test.ts": 'node.textContent = "Test only";', [`${CAT}/index.ts`]: 'x.textContent = "Not scanned";' }));
  assert.deepEqual(f, []);
});

test("unregistered catalogue pairs anywhere in the tree are found; ignore list suppresses", () => {
  const files = base({ "other/i18n/en.json": {}, "other/i18n/de.json": {}, "skip/en.json": {}, "skip/de.json": {}, "lonely/en.json": {} });
  const f = run(files, { ignore: ["skip/"] });
  assert.deepEqual(f.map((x) => [x.kind, x.file]), [["unregistered-catalogue", "other/i18n"]]);
});

test("invalid json is a finding, not a crash", () => {
  const f = run(base({ [`${CAT}/de.json`]: "{nope" }));
  assert.deepEqual(kinds(f), ["invalid-json"]);
  assert.equal(run(base({ [`${CAT}/en.json`]: "[1]" })).filter((x) => x.kind === "invalid-json").length, 1);
});

test("allowlist: suppresses by key or file, demands a reason, flags stale entries", () => {
  const files = base({ "ui/src/main.ts": 't("a.title"); node.textContent = "Saved changes";' });
  assert.equal(run(files).length, 2);
  const allow = [
    { kind: "dead-key", key: "a.body", reason: "r" },
    { kind: "hardcoded-text", file: "ui/src/main.ts", reason: "r" },
  ];
  assert.deepEqual(run(files, { allow }), []);
  assert.deepEqual(kinds(run(files, { allow: [...allow, { kind: "dead-key", key: "gone", reason: "r" }] })), ["stale-allow"]);
  assert.deepEqual(kinds(run(files, { allow: [{ ...allow[0], reason: "" }, allow[1]] })), ["stale-allow"]);
  // a kind-only entry never matches (no blanket suppression)
  assert.equal(run(files, { allow: [{ kind: "hardcoded-text", reason: "r" }] }).filter((x) => x.kind === "hardcoded-text").length, 1);
});

test("stripComments keeps strings and line numbers", () => {
  const out = stripComments('a("//not a comment") // gone\n/* x\ny */ b("`q`")');
  assert.equal(out.split("\n").length, 3);
  assert.ok(out.includes('"//not a comment"') && !out.includes("gone") && out.includes('"`q`"'));
});

test("CLI: exit 0 when clean, 1 with findings on stderr, 2 for a missing config", () => {
  tree({ ...base(), "cfg.json": { surfaces: [surface] }, "bad/cfg.json": {} }, (root) => {
    const ok = spawnSync(process.execPath, [script, "--root", root, "--config", join(root, "cfg.json")], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    writeFileSync(join(root, CAT, "de.json"), JSON.stringify({ "a.title": "Hallo" }));
    const bad = spawnSync(process.execPath, [script, "--root", root, "--config", join(root, "cfg.json")], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /missing-key/);
    assert.match(bad.stderr, /placeholder-mismatch/);
    const none = spawnSync(process.execPath, [script, "--root", root, "--config", join(root, "nope.json")], { encoding: "utf8" });
    assert.equal(none.status, 2);
  });
});

test("the real repo passes with its config", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
