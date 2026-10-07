// Builds the palette's search index: navigation (from nav.ts, so new pages appear by themselves), settings sections, actions and
// settings (settings-index.ts, optionally with current values), filtered by the signed-in role (docs/rbac.md). The entity groups
// (agents, sessions) and the log-search actions are built from fan-out answers and the query by the helpers below. Pure: language,
// values and role are parameters.
import { catalogues, type Key, type Lang } from "../i18n.ts";
import { ALL_ITEMS, GROUPS } from "../nav.ts";
import { isSensitiveKey, type Entry } from "./match.ts";
import { roleIn, type RolePreset } from "../pages/common/load.ts";
import { SECTIONS, sectionOf, settingsHref } from "../settings-sections.ts";
import { SETTINGS, type SettingSpec } from "./settings-index.ts";

export { settingsHref };

/** Sub-routes worth a nav entry of their own: path, parent nav id and label key (router.ts `sub`). Memories & Dreams is one nav
 * item with a Dreams sub-area. */
const SUB_ROUTES: readonly { path: string; parent: string; label: Key }[] = [
  { path: "/memories/dreams", parent: "memories", label: "palette.dreams" },
];

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

const ADMIN: readonly RolePreset[] = ["owner", "admin"];
/** Who may open the Logs page at all: logs.read (Owner, Admin, Operator, Viewer). Members never see Logs entries. */
const LOGS: readonly RolePreset[] = ["owner", "admin", "operator", "viewer"];
const NAV_ROLES: Record<string, readonly RolePreset[]> = { logs: LOGS };
/** Settings sections that are Owner/Admin only (users, secrets, devices; the config sections stay readable). */
const ADMIN_SECTIONS = new Set(["users", "secrets", "devices"]);

type ActionDef = { id: string; label: Key; to: string; roles?: readonly RolePreset[] };
/** Static commands; each is a route (no action runs from the palette itself). */
const ACTIONS: readonly ActionDef[] = [
  { id: "new-chat", label: "palette.action.newChat", to: "/chat/new" },
  { id: "create-agent", label: "palette.action.createAgent", to: "/agents/new", roles: ADMIN },
  { id: "run-setup", label: "palette.action.runSetup", to: "/setup", roles: ADMIN },
  { id: "open-logs", label: "palette.action.openLogs", to: "/logs", roles: LOGS },
  { id: "verify-audit", label: "palette.action.verifyAudit", to: "/logs/activity", roles: ADMIN },
];

const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
const TRACE = /^[0-9a-f]{8,}(?:-[0-9a-f]+)*$/i;

/** "Search logs for “q”" (and "Find trace “q”" for something shaped like a trace id): Owner/Admin only (logs.query). Always built
 * from the query, never matched against it. `/logs?trace=` is read by the viewer; `q` is the free-text hand-over (the viewer does not
 * read it yet, see the report). */
export function logSearchEntries(query: string, lang: Lang, role: string | undefined): Entry[] {
  const q = query.trim().slice(0, 120);
  if (q === "" || !roleIn(role, ADMIN)) return [];
  const mk = (id: string, key: Key, to: string): Entry => {
    const label = fill(catalogues[lang][key], { q });
    return { id: `action:${id}`, group: "log", label, labels: [label], key: to, to, roles: ADMIN };
  };
  return [mk("search-logs", "palette.action.searchLogs", `/logs?q=${encodeURIComponent(q)}`), ...(TRACE.test(q) ? [mk("find-trace", "palette.action.findTrace", `/logs?trace=${encodeURIComponent(q)}`)] : [])];
}

/** Agents from `config.get {key:"agents"}` (id -> display name). */
export function agentEntries(agents: readonly { id: string; name: string }[]): Entry[] {
  return agents.map((a) => ({ id: `agent:${a.id}`, group: "agent", label: a.name, labels: [...new Set([a.name, a.id])], key: a.id, to: `/agents/${encodeURIComponent(a.id)}` }));
}

/** Sessions from `session.list`; the chat route addresses a session as `/chat/<id>`. The server did the matching, so `labels` carries the
 * title only and the entries are shown in the server's order (see `fanout-sources.ts`). */
export function sessionEntries(sessions: readonly { id: string; title: string; agentId: string }[]): Entry[] {
  return sessions.map((s) => {
    const label = s.title !== "" ? s.title : s.id;
    return { id: `session:${s.id}`, group: "session", label, labels: [label], key: s.id, meta: s.agentId, to: `/chat/${encodeURIComponent(s.id)}` };
  });
}

export type BuildOptions = {
  lang: Lang;
  /** Dotted key -> value text, from `settingValues`. Sensitive keys are dropped here again, whatever is passed. */
  values?: Readonly<Record<string, string>> | null;
  settings?: readonly SettingSpec[];
  /** The signed-in role; entries the role may not see are left out. Undefined (not signed in, unknown role): the server decides. */
  role?: string | undefined;
};

export function buildIndex({ lang, values, settings = SETTINGS, role }: BuildOptions): Entry[] {
  const both = (key: Key): { label: string; labels: string[] } => ({
    label: catalogues[lang][key], labels: [...new Set([catalogues[lang][key], catalogues.en[key], catalogues.de[key]])],
  });
  const groupOf = new Map(GROUPS.flatMap((g) => g.items.map((i) => [i.id, g.label] as const)));
  const nav: Entry[] = ALL_ITEMS.map((item) => {
    const grp = groupOf.get(item.id);
    const roles = NAV_ROLES[item.id];
    return { id: `nav:${item.id}`, group: "nav", ...both(item.label), key: item.path, ...(grp ? { meta: catalogues[lang][grp] } : {}), to: item.path, ...(roles ? { roles } : {}) };
  });
  for (const sub of SUB_ROUTES) {
    const parent = ALL_ITEMS.find((i) => i.id === sub.parent);
    if (!parent) continue;
    const at = nav.findIndex((n) => n.to === parent.path);
    nav.splice(at + 1, 0, { id: `nav:${sub.path}`, group: "nav", ...both(sub.label), key: sub.path, meta: catalogues[lang][parent.label], to: sub.path });
  }
  const settingsLabel = catalogues[lang]["nav.settings"];
  const sections: Entry[] = SECTIONS.filter((s) => s.id !== "general").map((s) => ({
    id: `nav:/settings/${s.id}`, group: "nav", ...both(s.label), key: `/settings/${s.id}`, meta: settingsLabel, to: `/settings/${s.id}`,
    ...(ADMIN_SECTIONS.has(s.id) ? { roles: ADMIN } : {}),
  }));
  const actions: Entry[] = ACTIONS.map((a) => ({ id: `action:${a.id}`, group: "action", ...both(a.label), key: a.to, to: a.to, ...(a.roles ? { roles: a.roles } : {}) }));
  const set: Entry[] = settings.map((s) => {
    const value = isSensitiveKey(s.key) ? undefined : values?.[s.key];
    const label = humanize(s.key);
    return {
      id: `setting:${s.key}`, group: "setting", label, labels: [label], key: s.key, to: settingsHref(s.key),
      ...(s.help ? { help: s.help } : {}), ...(value !== undefined ? { value } : {}),
      ...(ADMIN_SECTIONS.has(sectionOf(s.key)?.id ?? "") ? { roles: ADMIN } : {}),
    };
  });
  return [...nav, ...sections, ...actions, ...set].filter((e) => !e.roles || roleIn(role, e.roles));
}
