import { test } from "node:test";
import assert from "node:assert/strict";
import en from "../src/i18n/en.json" with { type: "json" };
import de from "../src/i18n/de.json" with { type: "json" };
import { resolveLocale, translate, platformPlace } from "../src/i18n.ts";

test("both catalogues cover the same nonempty messages", () => {
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim(), `en ${key}`);
    assert.ok(de[key as keyof typeof de].trim(), `de ${key}`);
  }
});

test("platform words use the system's familiar location", () => {
  assert.deepEqual(["mac", "win", "gnome", "kde"].map(platform => platformPlace("en", platform as "mac" | "win" | "gnome" | "kde")), ["menu bar", "notification area", "top bar", "system tray"]);
});

test("system locale follows German and falls back to English", () => {
  assert.equal(resolveLocale("system", "de-DE"), "de");
  assert.equal(resolveLocale("system", "fr-FR"), "en");
  assert.equal(resolveLocale("en", "de-DE"), "en");
  assert.equal(translate("de", "nav.settings"), "Einstellungen");
});
