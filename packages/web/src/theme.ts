import { effect, signal } from "@preact/signals";
import { getPref, readCookie, setPref, writeCookie } from "./prefs.ts";

export type ThemePref = "system" | "light" | "dark";
export const THEME_ORDER: readonly ThemePref[] = ["system", "light", "dark"];

/** Cookie that keeps the choice across reloads without localStorage (Path=/, SameSite=Strict, readable by the page). */
export const THEME_COOKIE = "plur1bus_theme";
const ONE_YEAR_S = 31_536_000;

export function parseTheme(v: string | null | undefined): ThemePref | null {
  return v === "system" || v === "light" || v === "dark" ? v : null;
}

export type ThemeSources = { search: string; hash: string; cookie: string; stored: string | null };

/** Precedence: `?theme=` in the URL (query or hash query), then the cookie, then the localStorage cache, then "system".
 * Invalid values are skipped at every level. `fromUrl` tells the caller to persist an explicit URL choice. */
export function initialTheme(src: ThemeSources): { pref: ThemePref; fromUrl: boolean } {
  const hashQuery = src.hash.includes("?") ? src.hash.slice(src.hash.indexOf("?")) : "";
  for (const q of [src.search, hashQuery]) {
    const fromUrl = parseTheme(new URLSearchParams(q).get("theme"));
    if (fromUrl) return { pref: fromUrl, fromUrl: true };
  }
  return { pref: parseTheme(readCookie(src.cookie, THEME_COOKIE)) ?? parseTheme(src.stored) ?? "system", fromUrl: false };
}

export function themeCookie(p: ThemePref, secure: boolean): string {
  return `${THEME_COOKIE}=${p}; Path=/; SameSite=Strict; Max-Age=${ONE_YEAR_S}${secure ? "; Secure" : ""}`;
}

function documentCookie(): string {
  try { return globalThis.document?.cookie ?? ""; } catch { return ""; }
}

function persist(p: ThemePref): void {
  writeCookie(themeCookie(p, globalThis.location?.protocol === "https:"));
  setPref("theme", p); // additional cache only; never required
}

const start = initialTheme({
  search: globalThis.location?.search ?? "",
  hash: globalThis.location?.hash ?? "",
  cookie: documentCookie(),
  stored: getPref("theme"),
});

/** In memory, mirrored to the cookie and the optional local cache. */
export const themePref = signal<ThemePref>(start.pref);
if (start.fromUrl) persist(start.pref);

export function setThemePref(p: ThemePref): void {
  themePref.value = p;
  persist(p);
}

/** Mirror the preference on <html data-theme> and set the density. "system" removes the attribute so the CSS media query
 * decides (light when the OS asks for light, dark otherwise: ADR-004 amendment 2026-10-01, C2). */
export function bindTheme(root: HTMLElement = document.documentElement): () => void {
  root.dataset.density ??= "comfortable";
  return effect(() => {
    if (themePref.value === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", themePref.value);
  });
}
