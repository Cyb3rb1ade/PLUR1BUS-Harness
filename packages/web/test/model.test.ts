import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogues } from "../src/i18n.ts";
import { ALL_ITEMS, BOTTOM, GROUPS, LANDING } from "../src/nav.ts";
import { resolve } from "../src/router.ts";

test("i18n: de and en have the same keys and no empty text", () => {
  const en = Object.keys(catalogues.en).sort();
  assert.deepEqual(Object.keys(catalogues.de).sort(), en);
  for (const lang of ["en", "de"] as const) {
    for (const [k, v] of Object.entries(catalogues[lang])) assert.ok(v.trim().length > 0, `${lang}.${k} is empty`);
  }
});

test("i18n: placeholders match between languages", () => {
  const ph = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
  for (const k of Object.keys(catalogues.en) as (keyof typeof catalogues.en)[]) {
    assert.deepEqual(ph(catalogues.de[k]), ph(catalogues.en[k]), k);
  }
});

test("nav: groups Workspace, Build, Control with the canvas items; Settings and Help are pinned apart", () => {
  assert.deepEqual(GROUPS.map((g) => g.id), ["workspace", "build", "control"]);
  assert.deepEqual(GROUPS[0]!.items.map((i) => i.id), ["chat", "projects", "agents", "inbox", "memories"]);
  assert.deepEqual(GROUPS[1]!.items.map((i) => i.id), ["library", "skills", "plugins", "switchboard", "recurring"]);
  assert.deepEqual(GROUPS[2]!.items.map((i) => i.id), ["approvals", "usage", "logs"]);
  assert.deepEqual(BOTTOM.map((i) => i.id), ["settings", "help"]);
  assert.equal(new Set(ALL_ITEMS.map((i) => i.path)).size, ALL_ITEMS.length);
});

test("router: login, known pages, landing and unknown paths", () => {
  assert.equal(resolve("/login").kind, "login");
  for (const i of ALL_ITEMS) assert.deepEqual(resolve(i.path), { kind: "page", item: i });
  assert.equal(LANDING, "/chat");
  assert.deepEqual(resolve("/nope"), { kind: "not-found", path: "/nope" });
});
