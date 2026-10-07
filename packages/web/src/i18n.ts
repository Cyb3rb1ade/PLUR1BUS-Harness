import { computed, signal } from "@preact/signals";
import { getPref, setPref } from "./prefs.ts";

const en = {
  "app.skip": "Skip to content",
  "app.loading": "Checking your session…",
  "app.more": "More",
  "nav.main": "Main navigation",
  "nav.group.workspace": "Workspace",
  "nav.group.build": "Build",
  "nav.group.control": "Control",
  "nav.chat": "Chat",
  "nav.projects": "Projects",
  "nav.agents": "Agents",
  "nav.inbox": "Inbox",
  "nav.memories": "Memories & Dreams",
  "nav.library": "Library",
  "nav.skills": "Skills",
  "nav.plugins": "Plugins",
  "nav.switchboard": "Switchboard",
  "nav.recurring": "Recurring Tasks",
  "nav.approvals": "Approvals",
  "nav.usage": "Usage & Quota",
  "nav.logs": "Logs",
  "nav.settings": "Settings",
  "nav.help": "Help",
  "nav.search": "Search everything",
  "nav.menu": "Open menu",
  "nav.close": "Close menu",
  "page.placeholder": "This page is part of a later M3 step. The shell, theme and sign-in are in place.",
  "notfound.title": "Page not found",
  "notfound.body": "There is no page at this address.",
  "notfound.back": "Back to Chat",
  "theme.label": "Theme",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "lang.label": "Language",
  "lang.system": "System",
  "lang.en": "English",
  "lang.de": "Deutsch",
  "user.signedInAs": "Signed in as {name}",
  "user.signOut": "Sign out",
  "login.title": "Sign in",
  "login.lead": "Paste the owner token of this harness.",
  "login.token": "Owner token",
  "login.show": "Show token",
  "login.hide": "Hide token",
  "login.submit": "Sign in",
  "login.submitting": "Signing in…",
  "login.error.required": "Enter the owner token.",
  "login.error.invalid": "The token is not correct.",
  "login.error.rate": "Too many attempts. Try again in {seconds} s.",
  "login.error.rateUnknown": "Too many attempts. Try again in a moment.",
  "login.error.network": "The harness cannot be reached. Check that it is running.",
  "login.error.server": "The harness answered with an error ({status}). Try again.",
  "login.success": "Signed in.",
  "login.notice.expired": "Your session has expired. Sign in again.",
  "session.error.expired": "Your session has expired. Sign in again.",
  "session.error.csrf": "The request was refused (security token). Reload the page and try again.",
  "session.error.rate": "Too many requests. Try again in a moment.",
  "session.error.network": "The harness cannot be reached. Check that it is running.",
  "session.error.server": "The harness answered with an error ({status}). Try again.",
} as const;

export type Key = keyof typeof en;

const de: Record<Key, string> = {
  "app.skip": "Zum Inhalt springen",
  "app.loading": "Sitzung wird geprüft …",
  "app.more": "Mehr",
  "nav.main": "Hauptnavigation",
  "nav.group.workspace": "Arbeitsbereich",
  "nav.group.build": "Aufbau",
  "nav.group.control": "Kontrolle",
  "nav.chat": "Chat",
  "nav.projects": "Projekte",
  "nav.agents": "Agenten",
  "nav.inbox": "Posteingang",
  "nav.memories": "Erinnerungen & Träume",
  "nav.library": "Bibliothek",
  "nav.skills": "Skills",
  "nav.plugins": "Plugins",
  "nav.switchboard": "Vermittlung",
  "nav.recurring": "Wiederkehrende Aufgaben",
  "nav.approvals": "Freigaben",
  "nav.usage": "Nutzung & Kontingent",
  "nav.logs": "Protokolle",
  "nav.settings": "Einstellungen",
  "nav.help": "Hilfe",
  "nav.search": "Alles durchsuchen",
  "nav.menu": "Menü öffnen",
  "nav.close": "Menü schließen",
  "page.placeholder": "Diese Seite folgt in einem späteren M3-Schritt. Rahmen, Design und Anmeldung stehen.",
  "notfound.title": "Seite nicht gefunden",
  "notfound.body": "Unter dieser Adresse gibt es keine Seite.",
  "notfound.back": "Zurück zum Chat",
  "theme.label": "Design",
  "theme.system": "System",
  "theme.light": "Hell",
  "theme.dark": "Dunkel",
  "lang.label": "Sprache",
  "lang.system": "System",
  "lang.en": "English",
  "lang.de": "Deutsch",
  "user.signedInAs": "Angemeldet als {name}",
  "user.signOut": "Abmelden",
  "login.title": "Anmelden",
  "login.lead": "Füge das Owner-Token dieser Harness ein.",
  "login.token": "Owner-Token",
  "login.show": "Token anzeigen",
  "login.hide": "Token verbergen",
  "login.submit": "Anmelden",
  "login.submitting": "Anmeldung läuft …",
  "login.error.required": "Gib das Owner-Token ein.",
  "login.error.invalid": "Das Token stimmt nicht.",
  "login.error.rate": "Zu viele Versuche. Versuche es in {seconds} s erneut.",
  "login.error.rateUnknown": "Zu viele Versuche. Versuche es gleich noch einmal.",
  "login.error.network": "Die Harness ist nicht erreichbar. Prüfe, ob sie läuft.",
  "login.error.server": "Die Harness meldet einen Fehler ({status}). Versuche es erneut.",
  "login.success": "Angemeldet.",
  "login.notice.expired": "Deine Sitzung ist abgelaufen. Melde dich erneut an.",
  "session.error.expired": "Deine Sitzung ist abgelaufen. Melde dich erneut an.",
  "session.error.csrf": "Die Anfrage wurde abgelehnt (Sicherheits-Token). Lade die Seite neu und versuche es erneut.",
  "session.error.rate": "Zu viele Anfragen. Versuche es gleich noch einmal.",
  "session.error.network": "Die Harness ist nicht erreichbar. Prüfe, ob sie läuft.",
  "session.error.server": "Die Harness meldet einen Fehler ({status}). Versuche es erneut.",
};

export const catalogues = { en, de } as const;
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
