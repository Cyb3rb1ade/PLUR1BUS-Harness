// settings area catalogue (Settings page, `/settings/<section>`): keys `settings.<topic>`; en and de have the same keys and
// {placeholders}. The section labels are read by src/settings-sections.ts. The page agent adds its own keys below.
export const en = {
  "settings.title": "Settings",
  "settings.nav": "Settings sections",
  "settings.section.general": "General",
  "settings.section.models": "Models & providers",
  "settings.section.memory": "Memory",
  "settings.section.extensions": "Extensions",
  "settings.section.network": "Network",
  "settings.section.users": "Users & roles",
  "settings.section.secrets": "Secrets",
  "settings.section.devices": "Devices & remote",
} as const;

export const de: Record<keyof typeof en, string> = {
  "settings.title": "Einstellungen",
  "settings.nav": "Einstellungsbereiche",
  "settings.section.general": "Allgemein",
  "settings.section.models": "Modelle & Anbieter",
  "settings.section.memory": "Gedächtnis",
  "settings.section.extensions": "Erweiterungen",
  "settings.section.network": "Netzwerk",
  "settings.section.users": "Benutzer & Rollen",
  "settings.section.secrets": "Geheimnisse",
  "settings.section.devices": "Geräte & Fernzugriff",
};
