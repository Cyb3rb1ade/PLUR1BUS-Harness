import { GALLERY_ITEM, type NavItem } from "../nav.ts";
import type { View } from "../view.ts";
import { lazyPage } from "./lazy.ts";
import { PlaceholderPage } from "./placeholder.ts";

/** What the router hands to a page: its nav item and the sub-route (`/memories/dreams` -> sub "dreams"), if any. */
export type PageProps = { item: NavItem; sub?: string };
export type PageComponent = (props: PageProps) => View | null;

// Real pages are loaded on first use (dynamic import(), one chunk each; see lazy.ts). The placeholder is tiny and static.
const ChatPage = lazyPage(() => import("./chat/page.ts").then((m) => m.ChatPage));
const MemoriesPage = lazyPage(() => import("./memory/index.ts").then((m) => m.MemoriesPage));
const ModelsPage = lazyPage(() => import("./models/page.ts").then((m) => m.ModelsPage));
const BudgetPage = lazyPage(() => import("./budget/page.ts").then((m) => m.BudgetPage));
const DoctorPage = lazyPage(() => import("./doctor/page.ts").then((m) => m.DoctorPage));
const AgentsPage = lazyPage(() => import("./agents/page.ts").then((m) => m.AgentsPage));
const SettingsPage = lazyPage(() => import("./settings/page.ts").then((m) => m.SettingsPage));
const LogsPage = lazyPage(() => import("./logs/page.ts").then((m) => m.LogsPage));
const SetupPage = lazyPage(() => import("./setup/page.ts").then((m) => m.SetupPage));

/** Nav item id -> page. A page agent replaces exactly its own line (and adds its import above):
 *   import { MemoriesPage } from "./memories.ts";   ...   memories: MemoriesPage,
 * Pages render inside the shell's <main> and an ErrorBoundary; they own their <h1> (use `Page` from components/page.ts). */
export const PAGES: Readonly<Record<string, PageComponent>> = {
  chat: ChatPage,
  projects: PlaceholderPage,
  agents: AgentsPage,
  inbox: PlaceholderPage,
  memories: MemoriesPage,
  library: PlaceholderPage,
  skills: PlaceholderPage,
  plugins: PlaceholderPage,
  models: ModelsPage,
  switchboard: PlaceholderPage,
  recurring: PlaceholderPage,
  approvals: PlaceholderPage,
  usage: BudgetPage,
  doctor: DoctorPage,
  logs: LogsPage,
  settings: SettingsPage,
  help: PlaceholderPage,
  setup: SetupPage,
};

declare const __GALLERY__: boolean | undefined;
let galleryPage: PageComponent | undefined;

export function pageFor(id: string): PageComponent {
  // Written inline so that the bundler folds the build-time constant and drops the gallery from the shipped bundle.
  if (typeof __GALLERY__ !== "undefined" && __GALLERY__ && id === GALLERY_ITEM.id) return (galleryPage ??= lazyPage(() => import("./gallery.ts").then((m) => m.GalleryPage)));
  return PAGES[id] ?? PlaceholderPage;
}
