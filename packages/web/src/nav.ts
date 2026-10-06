import type { Key } from "./i18n.ts";
import type { IconName } from "./icons.ts";

export type NavItem = { id: string; path: string; label: Key; icon: IconName };
export type NavGroup = { id: "workspace" | "build" | "control"; label: Key; items: readonly NavItem[] };

const item = (id: string, label: Key, icon: IconName): NavItem => ({ id, path: `/${id}`, label, icon });

// Desktop spec §13.2 `V2Sidebar` (keys `chat` and `logs` added on the canvas 2026-10-06).
export const GROUPS: readonly NavGroup[] = [
  { id: "workspace", label: "nav.group.workspace", items: [
    item("chat", "nav.chat", "chat"), item("projects", "nav.projects", "projects"), item("agents", "nav.agents", "agents"),
    item("inbox", "nav.inbox", "inbox"), item("memories", "nav.memories", "memories"),
  ] },
  { id: "build", label: "nav.group.build", items: [
    item("library", "nav.library", "library"), item("skills", "nav.skills", "skills"), item("plugins", "nav.plugins", "plugins"),
    item("switchboard", "nav.switchboard", "switchboard"), item("recurring", "nav.recurring", "recurring"),
  ] },
  { id: "control", label: "nav.group.control", items: [
    item("approvals", "nav.approvals", "approvals"), item("usage", "nav.usage", "usage"), item("logs", "nav.logs", "logs"),
  ] },
];

export const BOTTOM: readonly NavItem[] = [item("settings", "nav.settings", "settings"), item("help", "nav.help", "help")];

export const ALL_ITEMS: readonly NavItem[] = [...GROUPS.flatMap((g) => g.items), ...BOTTOM];

/** First screen built and the default landing route (milestones M3, direct chat, owner call O2). */
export const LANDING = "/chat";
