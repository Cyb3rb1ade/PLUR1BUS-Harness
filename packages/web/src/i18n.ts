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

/** Translate; reads the language signal, so a component calling it re-renders on a language change. A key the active language
 *  lacks falls back to English, then to the key itself (a lazy area whose chunk has not registered yet must not render
 *  "undefined" or throw). `{name}` placeholders are replaced in one pass and literally: a value is never scanned again and
 *  `$&`-style replacement patterns have no meaning; a placeholder without a parameter stays visible. */
export function t(key: Key, params?: Record<string, string | number>): string {
  const s: string = catalogues[lang.value][key] ?? catalogues.en[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}

export function formatNumber(n: number): string { return new Intl.NumberFormat(lang.value).format(n); }
export function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat(lang.value, { dateStyle: "medium", timeStyle: "short" }).format(d);
}
