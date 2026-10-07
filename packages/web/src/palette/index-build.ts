// Builds the palette's search index: navigation (from nav.ts, so new pages appear by themselves) and settings (settings-index.ts,
// optionally with current values). Pure: language and values are parameters.
import { catalogues, type Key, type Lang } from "../i18n.ts";
import { ALL_ITEMS, GROUPS } from "../nav.ts";
import { isSensitiveKey, type Entry } from "./match.ts";
import { SETTINGS, type SettingSpec } from "./settings-index.ts";

/** Sub-routes worth a nav entry of their own: path, parent nav id and label key (router.ts `sub`). Memories & Dreams is one nav
 * item with a Dreams sub-area. */
const SUB_ROUTES: readonly { path: string; parent: string; label: Key }[] = [
  { path: "/memories/dreams", parent: "memories", label: "palette.dreams" },
];

/** Where a settings hit goes. The Settings page evaluates `?focus=<key>` to scroll to and focus that setting once it exists; until then
 * the page is a placeholder and the query is ignored (the router drops it from the path). */
export function settingsHref(key: string): string {
  return `/settings?focus=${encodeURIComponent(key)}`;
}

/** "core.recall.softBudgetMs" -> "Soft budget ms": the schema has no titles, so the label comes from the last key segment. */
export function humanize(key: string): string {
  const last = key.split(".").pop() ?? key;
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const scalar = (v: unknown): string | null =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : null;

/** Text values of the catalogued settings from a `config.get` value (the whole configuration). Objects and null are skipped, a list of
 * scalars is joined, and sensitive keys are never read. Anything that is not an object gives {}. */
export function settingValues(config: unknown, settings: readonly SettingSpec[] = SETTINGS): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof config !== "object" || config === null) return out;
  for (const { key } of settings) {
    if (isSensitiveKey(key)) continue;
    let at: unknown = config;
    for (const seg of key.split(".")) at = typeof at === "object" && at !== null ? (at as Record<string, unknown>)[seg] : undefined;
    const text = Array.isArray(at) ? (at.every((x) => scalar(x) !== null) && at.length > 0 ? at.map((x) => String(x)).join(", ") : null) : scalar(at);
    if (text !== null) out[key] = text;
  }
  return out;
}

export type BuildOptions = {
  lang: Lang;
  /** Dotted key -> value text, from `settingValues`. Sensitive keys are dropped here again, whatever is passed. */
  values?: Readonly<Record<string, string>> | null;
  settings?: readonly SettingSpec[];
};

export function buildIndex({ lang, values, settings = SETTINGS }: BuildOptions): Entry[] {
  const both = (key: Key): { label: string; labels: string[] } => ({
    label: catalogues[lang][key], labels: [...new Set([catalogues[lang][key], catalogues.en[key], catalogues.de[key]])],
  });
  const groupOf = new Map(GROUPS.flatMap((g) => g.items.map((i) => [i.id, g.label] as const)));
  const nav: Entry[] = ALL_ITEMS.map((item) => {
    const grp = groupOf.get(item.id);
    return { id: `nav:${item.id}`, group: "nav", ...both(item.label), key: item.path, ...(grp ? { meta: catalogues[lang][grp] } : {}), to: item.path };
  });
  for (const sub of SUB_ROUTES) {
    const parent = ALL_ITEMS.find((i) => i.id === sub.parent);
    if (!parent) continue;
    const at = nav.findIndex((n) => n.to === parent.path);
    nav.splice(at + 1, 0, { id: `nav:${sub.path}`, group: "nav", ...both(sub.label), key: sub.path, meta: catalogues[lang][parent.label], to: sub.path });
  }
  const set: Entry[] = settings.map((s) => {
    const value = isSensitiveKey(s.key) ? undefined : values?.[s.key];
    const label = humanize(s.key);
    return {
      id: `setting:${s.key}`, group: "setting", label, labels: [label], key: s.key, to: settingsHref(s.key),
      ...(s.help ? { help: s.help } : {}), ...(value !== undefined ? { value } : {}),
    };
  });
  return [...nav, ...set];
}
