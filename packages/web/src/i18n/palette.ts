// palette area catalogue: the command palette (⌘K / Ctrl+K), keys `palette.<topic>`; en and de have the same keys and {placeholders}.
export const en = {
  "palette.title": "Search everything",
  "palette.label": "Search pages and settings",
  "palette.placeholder": "Search pages and settings…",
  "palette.scope": "Searches pages and settings. Agents, memories and sessions are not searched yet.",
  "palette.group.nav": "Navigation",
  "palette.group.settings": "Settings",
  "palette.count.one": "1 result",
  "palette.count.other": "{n} results",
  "palette.none": "No results",
  "palette.hint": "↑ ↓ select · Enter open · Esc close",
  "palette.dreams": "Dreams",
} as const;

export const de: Record<keyof typeof en, string> = {
  "palette.title": "Alles durchsuchen",
  "palette.label": "Seiten und Einstellungen durchsuchen",
  "palette.placeholder": "Seiten und Einstellungen durchsuchen …",
  "palette.scope": "Durchsucht Seiten und Einstellungen. Agenten, Erinnerungen und Sitzungen werden noch nicht durchsucht.",
  "palette.group.nav": "Navigation",
  "palette.group.settings": "Einstellungen",
  "palette.count.one": "1 Treffer",
  "palette.count.other": "{n} Treffer",
  "palette.none": "Keine Treffer",
  "palette.hint": "↑ ↓ wählen · Enter öffnen · Esc schließen",
  "palette.dreams": "Träume",
};
