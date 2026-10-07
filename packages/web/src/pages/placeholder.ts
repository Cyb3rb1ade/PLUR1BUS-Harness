import { h } from "preact";
import type { View } from "../view.ts";
import { Page } from "../components/page.ts";
import { t } from "../i18n.ts";
import type { NavItem } from "../nav.ts";

export function PlaceholderPage({ item }: { item: NavItem }): View {
  return h(Page, { title: t(item.label), lead: t("page.placeholder") });
}
