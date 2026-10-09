import type { Key } from "./i18n.ts";
import type { IconName } from "./icons.ts";

export type NavItem = { id: string; path: string; label: Key; icon: IconName };
export type NavGroup = { id: "workspace" | "build" | "control"; label: Key; items: readonly NavItem[] };

const item = (id: string, label: Key, icon: IconName): NavItem => ({ id, path: `/${id}`, label, icon });

// `/memories/dreams` (Dreams is a sub-area of Memories), `/chat/<session>` and the budget page on `/usage` are sub-routes or
// aliases, not nav items; see router.ts `Route.page.sub`.
// Desktop spec §13.2 `V2Sidebar` (keys `chat` and `logs` added on the canvas 2026-10-06).
export const GROUPS: readonly NavGroup[] = [
  { id: "workspace", label: "nav.group.workspace", items: [
    item("chat", "nav.chat", "chat"), item("projects", "nav.projects", "projects"), item("agents", "nav.agents", "agents"),
    item("inbox", "nav.inbox", "inbox"), item("memories", "nav.memories", "memories"),
  ] },
  { id: "build", label: "nav.group.build", items: [
    item("library", "nav.library", "library"), item("skills", "nav.skills", "skills"), item("plugins", "nav.plugins", "plugins"),
    item("models", "nav.models", "models"), item("switchboard", "nav.switchboard", "switchboard"), item("recurring", "nav.recurring", "recurring"),
  ] },
  { id: "control", label: "nav.group.control", items: [
    item("approvals", "nav.approvals", "approvals"), item("usage", "nav.usage", "usage"), item("doctor", "nav.doctor", "doctor"), item("logs", "nav.logs", "logs"),
  ] },
];

export const BOTTOM: readonly NavItem[] = [item("settings", "nav.settings", "settings"), item("help", "nav.help", "help")];

export const ALL_ITEMS: readonly NavItem[] = [...GROUPS.flatMap((g) => g.items), ...BOTTOM];

/** Routed pages that have no sidebar entry (the first-run wizard `/setup`). The router resolves them and the registry has a page
 * for each; the sidebar and the palette's navigation group list ALL_ITEMS only. */
export const HIDDEN_ITEMS: readonly NavItem[] = [item("setup", "nav.setup", "settings"), item("media", "nav.media", "library"), item("identities", "nav.identities", "agents")];

/** First screen built and the default landing route (milestones M3, direct chat, owner call O2). */
export const LANDING = "/chat";

declare const __GALLERY__: boolean | undefined;
/** The pattern gallery (`#/gallery/<pattern>`) is a development and test fixture for the shared components. It exists only in
 * builds made with `buildWeb(dir, { gallery: true })` (tests, or `PLUR1BUS_WEB_GALLERY=1`); the shipped bundle drops it. */
export const GALLERY_ENABLED: boolean = typeof __GALLERY__ !== "undefined" && __GALLERY__ === true;
export const GALLERY_ITEM: NavItem = item("gallery", "nav.gallery", "models");
