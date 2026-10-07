import assert from "node:assert/strict";
import { test } from "node:test";
import { initialTheme, parseTheme, themeCookie, THEME_COOKIE } from "../src/theme.ts";

const none = { search: "", hash: "", cookie: "", stored: null };

test("parseTheme accepts exactly system, light and dark", () => {
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("system"), "system");
  for (const bad of ["Dark", "", "auto", null, undefined, " dark"]) assert.equal(parseTheme(bad), null);
});

test("initialTheme: URL parameter beats cookie beats local cache beats system", () => {
  assert.deepEqual(initialTheme(none), { pref: "system", fromUrl: false });
  assert.deepEqual(initialTheme({ ...none, stored: "light" }), { pref: "light", fromUrl: false });
  assert.deepEqual(initialTheme({ ...none, stored: "light", cookie: `a=b; ${THEME_COOKIE}=dark; c=d` }), { pref: "dark", fromUrl: false });
  assert.deepEqual(initialTheme({ ...none, cookie: `${THEME_COOKIE}=dark`, search: "?theme=light" }), { pref: "light", fromUrl: true });
  assert.deepEqual(initialTheme({ ...none, cookie: `${THEME_COOKIE}=dark`, hash: "#/usage?theme=system" }), { pref: "system", fromUrl: true });
});

test("initialTheme ignores invalid values at every level", () => {
  assert.deepEqual(initialTheme({ search: "?theme=neon", hash: "#/chat?theme=x", cookie: `${THEME_COOKIE}=blue`, stored: "red" }), { pref: "system", fromUrl: false });
  assert.deepEqual(initialTheme({ ...none, search: "?theme=neon", cookie: `${THEME_COOKIE}=dark` }), { pref: "dark", fromUrl: false });
});

test("themeCookie is Path=/, SameSite=Strict, one year, Secure only over https", () => {
  const c = themeCookie("dark", false);
  assert.match(c, /^plur1bus_theme=dark; /);
  assert.match(c, /; Path=\//);
  assert.match(c, /; SameSite=Strict/);
  assert.match(c, /; Max-Age=31536000/);
  assert.doesNotMatch(c, /Secure/);
  assert.match(themeCookie("light", true), /; Secure/);
  assert.doesNotMatch(c, /HttpOnly/i); // the page must read it back
});
