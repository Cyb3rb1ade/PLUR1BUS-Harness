import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_ITEMS, HIDDEN_ITEMS } from "../src/nav.ts";
import { PAGES, pageFor } from "../src/pages/registry.ts";
import { PlaceholderPage } from "../src/pages/placeholder.ts";

test("pageFor: an id that is not a page is the placeholder, also for names Object.prototype has", () => {
  for (const id of ["nope", "", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) assert.equal(pageFor(id), PlaceholderPage, id);
});

test("every nav item that is not hidden resolves to a real page except those intentionally still placeholders", () => {
  const placeholders = [...ALL_ITEMS, ...HIDDEN_ITEMS].filter((i) => pageFor(i.id) === PlaceholderPage).map((i) => i.id);
  assert.deepEqual(placeholders, []);
  for (const id of Object.keys(PAGES)) assert.ok([...ALL_ITEMS, ...HIDDEN_ITEMS].some((i) => i.id === id), `PAGES.${id} has no nav item`);
});
