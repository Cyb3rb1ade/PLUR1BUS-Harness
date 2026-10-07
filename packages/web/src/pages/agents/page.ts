// Placeholder, replaced by the Agents page (list, detail, create).
import { h } from "preact";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { t } from "../../i18n.ts";
import type { PageProps } from "../registry.ts";

export function AgentsPage({ item }: PageProps): View {
  return h(Page, { title: t(item.label), width: "full" });
}
