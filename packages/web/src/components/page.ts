import { h, type ComponentChildren } from "preact";
import type { View } from "../view.ts";
import { t } from "../i18n.ts";
import { compact } from "../layout.ts";
import { MoreMenu } from "./more-menu.ts";

export type PageLayoutProps = {
  /** The page's one <h1>; the shell moves focus here on navigation. */
  title: string;
  /** Page-level actions (buttons, links). Inline at normal and wide; in compact they move into a "More actions" menu. */
  actions?: ComponentChildren;
  /** One-line summary under the heading (capped at 72ch). */
  lead?: string;
  /** "settings" (default): content capped at 880 px. "full": uses the whole content column (list-detail, tables). */
  width?: "settings" | "full";
  children?: ComponentChildren;
};

/** Standard page frame: heading, header actions with the compact More behaviour, optional lead, then the body.
 *  h(Page, { title: t("nav.models"), actions: h("button", ...) }, body) */
export function Page({ title, actions, lead, width = "settings", children }: PageLayoutProps): View {
  const hasActions = actions !== undefined && actions !== null && actions !== false;
  return h("div", { class: width === "full" ? "page-inner page-full" : "page-inner" },
    h("header", { class: "page-head" },
      h("h1", { tabIndex: -1 }, title),
      hasActions
        ? compact.value
          ? h(MoreMenu, { id: "page-actions-panel", label: t("app.moreActions"), icon: "more", class: "page-actions" }, actions)
          : h("div", { class: "page-actions" }, actions)
        : null),
    lead ? h("p", { class: "lead" }, lead) : null,
    children);
}
