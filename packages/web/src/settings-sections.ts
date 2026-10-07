// The routed sections of the Settings page (`/settings/<section>`) and which section owns which configuration key. One module,
// so the page, its navigation and the palette's settings hits (`/settings/<section>?focus=<key>`) agree.
import type { Key } from "./i18n.ts";

export type SectionKind = "config" | "users" | "secrets" | "devices";
export type SectionDef = {
  id: string;
  kind: SectionKind;
  label: Key;
  /** For a `config` section: which dotted keys it edits (exact key or `prefix.`). */
  keys?: readonly string[];
};

/** Order is the order of the navigation. `general` is the landing section of `/settings`. */
export const SECTIONS: readonly SectionDef[] = [
  { id: "general", kind: "config", label: "settings.section.general", keys: ["core.", "supervisor.", "logs.", "metrics.", "modules"] },
  { id: "models", kind: "config", label: "settings.section.models", keys: ["modelRoles", "modelProfiles", "models.", "providers", "oauth", "decision"] },
  { id: "memory", kind: "config", label: "settings.section.memory", keys: ["embedding.", "engine"] },
  { id: "extensions", kind: "config", label: "settings.section.extensions", keys: ["extensions."] },
  { id: "network", kind: "config", label: "settings.section.network", keys: ["egress."] },
  { id: "users", kind: "users", label: "settings.section.users" },
  { id: "secrets", kind: "secrets", label: "settings.section.secrets", keys: ["secrets."] },
  { id: "devices", kind: "devices", label: "settings.section.devices" },
];

export const DEFAULT_SECTION = "general";

export function sectionById(id: string | undefined): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

const matches = (key: string, pattern: string): boolean => (pattern.endsWith(".") ? key.startsWith(pattern) : key === pattern || key.startsWith(`${pattern}.`));

/** The section that edits `key`, or undefined for a key edited elsewhere (`agents` lives on the Agents page, `$schema` and
 * `schemaVersion` are not settings). */
export function sectionOf(key: string): SectionDef | undefined {
  return SECTIONS.find((s) => s.keys?.some((p) => matches(key, p)));
}

/** Where a settings hit goes: the section's route with `?focus=<key>`. `agents` goes to the Agents page. */
export function settingsHref(key: string): string {
  if (key === "agents" || key.startsWith("agents.")) return "/agents";
  const s = sectionOf(key);
  return `/settings/${s?.id ?? DEFAULT_SECTION}?focus=${encodeURIComponent(key)}`;
}
