import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { catalogues, setLangPref, t, type Key } from "../src/i18n.ts";

afterEach(() => { setLangPref("en"); delete (catalogues.en as Record<string, string>)["test.only.en"]; delete (catalogues.en as Record<string, string>)["test.param"]; delete (catalogues.de as Record<string, string>)["test.param"]; });
const put = (lang: "en" | "de", k: string, v: string): void => { (catalogues[lang] as Record<string, string>)[k] = v; };

describe("t()", () => {
  test("a key that is not in the catalogue (lazy area not loaded) neither throws nor renders empty", () => {
    assert.equal(t("no.such.key" as Key), "no.such.key");
    assert.equal(t("no.such.key" as Key, { n: 3 }), "no.such.key");
  });

  test("a key missing in the active language falls back to English", () => {
    put("en", "test.only.en", "English only");
    setLangPref("de");
    assert.equal(t("test.only.en" as Key), "English only");
  });

  test("parameter values are inserted literally: replacement patterns, braces and HTML stay as typed", () => {
    put("en", "test.param", "Hello {name}, {n} left");
    assert.equal(t("test.param" as Key, { name: "$& $1 $$ $`", n: 2 }), "Hello $& $1 $$ $`, 2 left");
    assert.equal(t("test.param" as Key, { name: "{n}", n: 5 }), "Hello {n}, 5 left", "a value containing {n} is not substituted again");
    assert.equal(t("test.param" as Key, { name: "<img onerror=x>", n: 1 }), "Hello <img onerror=x>, 1 left");
  });

  test("missing parameters stay visible as {name}; surplus parameters are ignored; repeated placeholders are all replaced", () => {
    put("en", "test.param", "{a} and {a} and {b}");
    assert.equal(t("test.param" as Key, { a: "x", extra: "y" }), "x and x and {b}");
  });

  test("inherited object properties are no parameters", () => {
    put("en", "test.param", "{toString} {constructor}");
    assert.equal(t("test.param" as Key, {}), "{toString} {constructor}");
  });
});
