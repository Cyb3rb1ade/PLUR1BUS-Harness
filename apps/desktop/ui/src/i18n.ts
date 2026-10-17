import en from "./i18n/en.json" with { type: "json" };
import de from "./i18n/de.json" with { type: "json" };

export type LocaleChoice = "system" | "en" | "de";
export type Locale = "en" | "de";
export type MessageKey = keyof typeof en;

export function platformPlace(locale: Locale, platform: "mac" | "win" | "gnome" | "kde"): string {
  return translate(locale, `platform.${platform}`);
}

export function resolveLocale(choice: LocaleChoice, systemLanguage: string): Locale {
  if (choice !== "system") return choice;
  return /^de(?:[-_]|$)/i.test(systemLanguage) ? "de" : "en";
}

export function translate(locale: Locale, key: MessageKey, values?: Record<string, string>): string {
  // Keys built from native strings (states, kinds) can miss a catalogue: fall back instead of throwing mid-render.
  const message = ((locale === "de" ? de : en) as Record<string, string | undefined>)[key] ?? (en as Record<string, string | undefined>)[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? "");
}
