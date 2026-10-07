import { h, type ComponentChildren } from "preact";
import { useId, useRef } from "preact/hooks";
import type { View } from "../view.ts";

export type TabDef = { id: string; label: string; panel: ComponentChildren };
export type TabsProps = {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabDef[];
  selected: string;
  onSelect: (id: string) => void;
};

/** ARIA tabs with automatic activation: Left/Right (wrapping), Home and End move and select; only the selected tab is in the
 * Tab order, and only the selected panel renders its content (the others stay as empty hidden panels so aria-controls resolves).
 *  h(Tabs, { label: t("memory.views"), tabs: [{ id: "list", label, panel }, { id: "dreams", label, panel }], selected, onSelect }) */
export function Tabs({ label, tabs, selected, onSelect }: TabsProps): View {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const current = tabs.some((x) => x.id === selected) ? selected : tabs[0]?.id;

  const onKeyDown = (e: KeyboardEvent): void => {
    const i = tabs.findIndex((x) => x.id === current);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = tabs[next]!;
    refs.current.get(target.id)?.focus();
    onSelect(target.id);
  };

  return h("div", { class: "tabs" },
    h("div", { class: "tablist", role: "tablist", "aria-label": label, onKeyDown },
      tabs.map((x) => h("button", {
        key: x.id, type: "button", role: "tab", class: "tab", id: `${base}-tab-${x.id}`, "aria-selected": x.id === current, "aria-controls": `${base}-panel-${x.id}`,
        tabIndex: x.id === current ? 0 : -1, ref: (el: HTMLButtonElement | null) => { if (el) refs.current.set(x.id, el); else refs.current.delete(x.id); },
        onClick: () => onSelect(x.id),
      }, x.label))),
    tabs.map((x) => h("div", {
      key: x.id, role: "tabpanel", class: "tabpanel", id: `${base}-panel-${x.id}`, "aria-labelledby": `${base}-tab-${x.id}`, tabIndex: 0, hidden: x.id !== current,
    }, x.id === current ? x.panel : null)));
}
