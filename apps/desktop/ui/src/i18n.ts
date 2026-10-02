import en from "./i18n/en.json" with { type: "json" };
import de from "./i18n/de.json" with { type: "json" };

export type LocaleChoice = "system" | "en" | "de";
export type Locale = "en" | "de";
export type MessageKey = keyof typeof en;

export function resolveLocale(choice: LocaleChoice, systemLanguage: string): Locale {
  if (choice !== "system") return choice;
  return /^de(?:[-_]|$)/i.test(systemLanguage) ? "de" : "en";
}

export function translate(locale: Locale, key: MessageKey, values?: Record<string, string>): string {
  const message = (locale === "de" ? de : en)[key];
  return message.replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? "");
}
