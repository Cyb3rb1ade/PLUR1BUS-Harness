import { computed, signal } from "@preact/signals";
import { en, de, type Key } from "./i18n/index.ts";
import { getPref, setPref } from "./prefs.ts";

export type { Key };
export const catalogues: { readonly en: Readonly<Record<Key, string>>; readonly de: Readonly<Record<Key, string>> } = { en, de };
export type Lang = "en" | "de";
export type LangPref = "system" | Lang;

const stored = getPref("lang");
export const langPref = signal<LangPref>(stored === "en" || stored === "de" ? stored : "system");

function systemLang(): Lang {
  const first = globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? "en";
  return first.toLowerCase().startsWith("de") ? "de" : "en";
}

export const lang = computed<Lang>(() => (langPref.value === "system" ? systemLang() : langPref.value));

export function setLangPref(p: LangPref): void {
  langPref.value = p;
  setPref("lang", p);
}

/** Translate; reads the language signal, so a component calling it re-renders on a language change. */
export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = catalogues[lang.value][key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function formatNumber(n: number): string { return new Intl.NumberFormat(lang.value).format(n); }
export function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat(lang.value, { dateStyle: "medium", timeStyle: "short" }).format(d);
}
