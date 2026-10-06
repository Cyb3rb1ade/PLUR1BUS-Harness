import { h } from "preact";
import type { View } from "../view.ts";
import { t } from "../i18n.ts";
import type { NavItem } from "../nav.ts";

export function PlaceholderPage({ item }: { item: NavItem }): View {
  return h("div", { class: "page-inner" },
    h("h1", { tabIndex: -1 }, t(item.label)),
    h("p", { class: "lead" }, t("page.placeholder")));
}
