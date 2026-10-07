import { h, type ComponentChildren } from "preact";
import type { View } from "../view.ts";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { icon, type IconName } from "../icons.ts";

export type MoreMenuProps = {
  /** Id of the disclosure panel (also `aria-controls`); unique per page. */
  id: string;
  /** Accessible name of the trigger button (visually hidden). */
  label: string;
  icon?: IconName;
  class?: string;
  children?: ComponentChildren;
};

/** A disclosure button with a panel (compact "More" menus: header actions, page actions). Esc closes it and returns
 * focus to the button; a press outside closes it. The document listeners are attached in a layout effect, i.e. in the
 * same commit that shows the panel: a passive `useEffect` runs after the next paint, so an Esc pressed right after
 * opening (a fast keyboard user, a test driver) used to reach no listener and the panel stayed open. */
export function MoreMenu({ id, label, icon: glyph = "menu", class: cls, children }: MoreMenuProps): View {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (e: Event): void => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return h("div", { class: `more${cls ? ` ${cls}` : ""}`, ref: root },
    h("button", { type: "button", ref: button, class: "icon-btn", "aria-expanded": open, "aria-controls": id, onClick: () => setOpen(!open) },
      icon(glyph), h("span", { class: "sr-only" }, label)),
    open ? h("div", { id, class: "more-panel" }, children) : null);
}
