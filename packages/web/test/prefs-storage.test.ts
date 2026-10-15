// prefs.ts and theme.ts against broken storage (blocked, throwing, full, stale): the page keeps working and the newest choice wins.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { getPref, readCookie, setPref, writeCookie } from "../src/prefs.ts";

const g = globalThis as Record<string, unknown>;
afterEach(() => { delete g.localStorage; delete g.document; });

describe("prefs: storage that misbehaves", () => {
  test("a localStorage getter that throws (blocked site data) is survived in both directions", () => {
    Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    assert.equal(getPref("k-blocked"), null);
    setPref("k-blocked", "v1");
    assert.equal(getPref("k-blocked"), "v1");
  });

  test("getItem and setItem that throw are survived", () => {
    g.localStorage = { getItem() { throw new Error("io"); }, setItem() { throw new Error("quota"); } };
    setPref("k-throw", "v1");
    assert.equal(getPref("k-throw"), "v1");
  });

  test("when the write fails (quota) the new value wins over the stale stored one", () => {
    g.localStorage = { getItem: () => "old", setItem() { throw new DOMException("full", "QuotaExceededError"); } };
    assert.equal(getPref("k-stale"), "old");
    setPref("k-stale", "new");
    assert.equal(getPref("k-stale"), "new");
  });

  test("a stored value is read when this page has not set one", () => {
    g.localStorage = { getItem: (k: string) => (k === "plur1bus.web.k-read" ? "stored" : null), setItem() {} };
    assert.equal(getPref("k-read"), "stored");
  });

  test("a non-string answer from the storage is not returned as a preference", () => {
    g.localStorage = { getItem: () => 42, setItem() {} };
    assert.equal(getPref("k-num"), null);
  });
});

describe("cookies that misbehave", () => {
  test("writeCookie does not throw when document.cookie is not writable", () => {
    g.document = { set cookie(_v: string) { throw new DOMException("sandboxed", "SecurityError"); } };
    assert.doesNotThrow(() => { writeCookie("a=b"); });
  });

  test("readCookie tolerates empty, malformed and duplicated parts", () => {
    assert.equal(readCookie("", "a"), null);
    assert.equal(readCookie("a; b=2;;=x; c=", "b"), "2");
    assert.equal(readCookie("a=1; a=2", "a"), "1");
    assert.equal(readCookie("xa=1", "a"), null);
    assert.equal(readCookie(`a=${"x".repeat(100_000)}`, "a")?.length, 100_000);
  });
});

describe("theme with broken storage", () => {
  test("loading and choosing a theme work with a blocked localStorage and a throwing cookie jar", async () => {
    Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    g.document = { get cookie(): string { throw new DOMException("sandboxed", "SecurityError"); }, set cookie(_v: string) { throw new DOMException("sandboxed", "SecurityError"); } };
    const theme = await import("../src/theme.ts");
    assert.equal(theme.themePref.value, "system");
    assert.doesNotThrow(() => { theme.setThemePref("dark"); });
    assert.equal(theme.themePref.value, "dark");
    assert.equal(getPref("theme"), "dark");
    theme.setThemePref("system");
  });

  test("initialTheme skips invalid values at every level and ignores a huge hash without a query", async () => {
    const { initialTheme } = await import("../src/theme.ts");
    const big = `#/${"a".repeat(500_000)}`;
    assert.deepEqual(initialTheme({ search: "?theme=neon", hash: big, cookie: "plur1bus_theme=bogus", stored: "dark" }), { pref: "dark", fromUrl: false });
    assert.deepEqual(initialTheme({ search: "", hash: "#/chat?x=1&theme=light&theme=dark", cookie: "", stored: null }), { pref: "light", fromUrl: true });
    assert.deepEqual(initialTheme({ search: "", hash: "#/chat?theme=%E0%A4%A", cookie: "plur1bus_theme=light", stored: null }), { pref: "light", fromUrl: false });
    assert.deepEqual(initialTheme({ search: "?theme=__proto__", hash: "", cookie: "", stored: "toString" }), { pref: "system", fromUrl: false });
  });
});
