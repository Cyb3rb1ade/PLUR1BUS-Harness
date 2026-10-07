// Placeholder, replaced by the first-run wizard.
import { h } from "preact";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { t } from "../../i18n.ts";
import type { PageProps } from "../registry.ts";

export function SetupPage({ item }: PageProps): View {
  return h(Page, { title: t(item.label) });
}
