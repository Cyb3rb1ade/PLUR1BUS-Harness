import { GALLERY_ITEM, type NavItem } from "../nav.ts";
import type { View } from "../view.ts";
import { ChatPage } from "./chat/page.ts";
import { DoctorPage } from "./doctor/page.ts";
import { GalleryPage } from "./gallery.ts";
import { ModelsPage } from "./models/page.ts";
import { PlaceholderPage } from "./placeholder.ts";

/** What the router hands to a page: its nav item and the sub-route (`/memories/dreams` -> sub "dreams"), if any. */
export type PageProps = { item: NavItem; sub?: string };
export type PageComponent = (props: PageProps) => View | null;

/** Nav item id -> page. A page agent replaces exactly its own line (and adds its import above):
 *   import { MemoriesPage } from "./memories.ts";   ...   memories: MemoriesPage,
 * Pages render inside the shell's <main> and an ErrorBoundary; they own their <h1> (use `Page` from components/page.ts). */
export const PAGES: Readonly<Record<string, PageComponent>> = {
  chat: ChatPage,
  projects: PlaceholderPage,
  agents: PlaceholderPage,
  inbox: PlaceholderPage,
  memories: PlaceholderPage,
  library: PlaceholderPage,
  skills: PlaceholderPage,
  plugins: PlaceholderPage,
  models: ModelsPage,
  switchboard: PlaceholderPage,
  recurring: PlaceholderPage,
  approvals: PlaceholderPage,
  usage: PlaceholderPage,
  doctor: DoctorPage,
  logs: PlaceholderPage,
  settings: PlaceholderPage,
  help: PlaceholderPage,
};

declare const __GALLERY__: boolean | undefined;

export function pageFor(id: string): PageComponent {
  // Written inline so that the bundler folds the build-time constant and drops the gallery from the shipped bundle.
  if (typeof __GALLERY__ !== "undefined" && __GALLERY__ && id === GALLERY_ITEM.id) return GalleryPage;
  return PAGES[id] ?? PlaceholderPage;
}
