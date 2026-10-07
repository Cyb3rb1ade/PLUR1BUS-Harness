import { h, type ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { View } from "../view.ts";
import { t } from "../i18n.ts";
import { icon } from "../icons.ts";
import { compact } from "../layout.ts";

export type ListDetailProps = {
  list: ComponentChildren;
  detail: ComponentChildren;
  /** Whether an item is selected. Normal and wide show both columns either way; compact shows the detail OR the list. */
  selected: boolean;
  listLabel: string;
  detailLabel: string;
  /** Compact "Back" button: clear the selection (usually navigate to the list route). */
  onBack: () => void;
  /** Shown in the detail column when nothing is selected (default: a hint). */
  empty?: ComponentChildren;
};

/** Two columns at normal and wide (list 240-340 px, detail the rest); in compact a push navigation: the list, or the detail
 * with a Back button. The switch is pure CSS (the hidden pane is display:none, so it leaves the accessibility tree); focus
 * moves to the detail on selecting and back to the list on Back. Keep the selection in the URL (`/chat/<id>`) so Back works.
 *  h(Page, { title, width: "full" }, h(ListDetail, { list, detail, selected: id !== null, listLabel, detailLabel, onBack })) */
export function ListDetail({ list, detail, selected, listLabel, detailLabel, onBack, empty }: ListDetailProps): View {
  const listEl = useRef<HTMLElement>(null);
  const detailEl = useRef<HTMLElement>(null);
  const was = useRef(selected);
  const isCompact = compact.value;
  useLayoutEffect(() => {
    if (isCompact && selected !== was.current) (selected ? detailEl : listEl).current?.focus();
    was.current = selected;
  }, [selected, isCompact]);

  return h("div", { class: "list-detail", "data-selected": String(selected) },
    h("section", { class: "ld-list", "aria-label": listLabel, tabIndex: -1, ref: listEl }, list),
    h("section", { class: "ld-detail", "aria-label": detailLabel, tabIndex: -1, ref: detailEl },
      h("button", { type: "button", class: "btn btn-quiet ld-back", onClick: onBack }, icon("back"), t("ld.back")),
      selected ? detail : (empty ?? h("p", { class: "ld-empty" }, t("ld.select")))));
}
