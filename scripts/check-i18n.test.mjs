// Unit tests for scripts/check-i18n.mjs (run by `pnpm lint`): fixture trees in temp dirs, never the real repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, placeholders } from "./check-i18n.mjs";

const script = fileURLToPath(new URL("./check-i18n.mjs", import.meta.url));
const CFG = { catalogues: [{ file: "web/i18n.ts", en: "en", de: "de" }], sources: ["web"], allowlist: "scripts/allow.json" };

const catalogue = (en, de) =>
  `const en = {\n${en.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n} as const;\n` +
  `const de: Record<string, string> = {\n${de.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n};\n`;

const GOOD_EN = [["a.title", "Hello"], ["a.who", "Hi {name}"]];
const GOOD_DE = [["a.title", "Hallo"], ["a.who", "Hallo {name}"]];
const GOOD_UI = `h("p", {}, t("a.title"));\nh("p", {}, t("a.who", { name }));\n`;

function tree(files, run = (root) => check(root)) {
  const root = mkdtempSync(join(tmpdir(), "p1b-i18n-"));
  try {
    const all = { "scripts/i18n.config.json": JSON.stringify(CFG), "scripts/allow.json": "{}", ...files };
    for (const [rel, text] of Object.entries(all)) {
      const p = join(root, ...rel.split("/"));
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const base = (over = {}) => ({ "web/i18n.ts": catalogue(GOOD_EN, GOOD_DE), "web/ui.ts": GOOD_UI, ...over });

test("a complete catalogue passes", () => assert.deepEqual(tree(base()), []));

test("placeholders compares sets", () => assert.deepEqual(placeholders("{b} x {a} {b}"), ["a", "b"]));

test("missing translation is reported in both directions", () => {
  const e = tree(base({ "web/i18n.ts": catalogue(GOOD_EN, GOOD_DE.slice(0, 1)) }));
  assert.ok(e.some((m) => m.includes('"a.who" missing in de')), e.join("\n"));
  const f = tree(base({ "web/i18n.ts": catalogue(GOOD_EN.slice(0, 1), GOOD_DE) }));
  assert.ok(f.some((m) => m.includes('"a.who" missing in en')), f.join("\n"));
});

test("placeholder mismatch is reported", () => {
  const e = tree(base({ "web/i18n.ts": catalogue(GOOD_EN, [GOOD_DE[0], ["a.who", "Hallo {nom}"]]) }));
  assert.ok(e.some((m) => m.includes('placeholders differ for "a.who"')), e.join("\n"));
});

test("dead key is reported unless allowlisted with a reason entry", () => {
  const cat = catalogue([...GOOD_EN, ["a.dead", "Old"]], [...GOOD_DE, ["a.dead", "Alt"]]);
  const e = tree(base({ "web/i18n.ts": cat }));
  assert.ok(e.some((m) => m.includes('dead key "a.dead"')), e.join("\n"));
  const ok = tree(base({ "web/i18n.ts": cat, "scripts/allow.json": JSON.stringify({ deadKeys: [{ file: "web/i18n.ts", key: "a.dead", reason: "x" }] }) }));
  assert.deepEqual(ok, []);
});

test("t() with an unknown key is reported", () => {
  const e = tree(base({ "web/ui.ts": GOOD_UI + `h("p", {}, t("a.nope"));\n` }));
  assert.ok(e.some((m) => m.includes('t("a.nope")')), e.join("\n"));
});

test("hard-coded child text and aria-label are reported, allowlist silences them", () => {
  const ui = GOOD_UI + `h("button", { "aria-label": "Close it" }, "Click me");\nh("i", { class: "icon btn" }, "1");\nif (e.key === "Escape") x();\n`;
  const e = tree(base({ "web/ui.ts": ui }));
  assert.equal(e.filter((m) => m.includes("hard-coded")).length, 2, e.join("\n"));
  assert.ok(e.some((m) => m.includes('"Click me"')) && e.some((m) => m.includes('"Close it"')));
  const allow = { entries: [{ file: "web/ui.ts", text: "Click me" }, { file: "web/ui.ts", text: "Close it" }] };
  assert.deepEqual(tree(base({ "web/ui.ts": ui, "scripts/allow.json": JSON.stringify(allow) })), []);
});

test("an unparseable catalogue line fails closed", () => {
  const bad = catalogue(GOOD_EN, GOOD_DE).replace('"Hello",', '`Hello`,');
  const e = tree(base({ "web/i18n.ts": bad }));
  assert.ok(e.some((m) => m.includes("unparseable catalogue line")), e.join("\n"));
});

test("CLI exits 1 with findings and 0 when clean", () => {
  const run = (root) => spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(tree(base(), run).status, 0);
  const r = tree(base({ "web/i18n.ts": catalogue(GOOD_EN, GOOD_DE.slice(0, 1)) }), run);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing in de/);
});
