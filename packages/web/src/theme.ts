import { effect, signal } from "@preact/signals";
import { getPref, setPref } from "./prefs.ts";

export type ThemePref = "system" | "light" | "dark";
export const THEME_ORDER: readonly ThemePref[] = ["system", "light", "dark"];

const stored = getPref("theme");
export const themePref = signal<ThemePref>(stored === "light" || stored === "dark" ? stored : "system");

export function setThemePref(p: ThemePref): void {
  themePref.value = p;
  setPref("theme", p);
}

/** Mirror the preference on <html data-theme>. "system" removes the attribute so the CSS media query decides
 * (light when the OS asks for light, dark otherwise: ADR-004 amendment 2026-10-01, C2). */
export function bindTheme(root: HTMLElement = document.documentElement): () => void {
  return effect(() => {
    if (themePref.value === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", themePref.value);
  });
}
