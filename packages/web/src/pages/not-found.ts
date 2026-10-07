import { h } from "preact";
import type { View } from "../view.ts";
import { t } from "../i18n.ts";
import { LANDING } from "../nav.ts";

export function NotFoundPage(): View {
  return h("div", { class: "page-inner" },
    h("h1", { tabIndex: -1 }, t("notfound.title")),
    h("p", { class: "lead" }, t("notfound.body")),
    h("a", { class: "btn", href: `#${LANDING}` }, t("notfound.back")));
}
