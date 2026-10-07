import { h, type ComponentChildren } from "preact";
import { useId, useLayoutEffect, useRef } from "preact/hooks";
import type { View } from "../view.ts";
import { t } from "../i18n.ts";
import { icon } from "../icons.ts";

export type DialogProps = {
  title: string;
  /** Called for Esc, the close button and a click on the backdrop. The caller unmounts the dialog. */
  onClose: () => void;
  /** Footer buttons. */
  actions?: ComponentChildren;
  children?: ComponentChildren;
};

/** Modal dialog on the native <dialog> (showModal): the page behind is inert, Tab stays inside, Esc closes. At most 680 px wide
 * (--w-dialog) and never wider than the window. Mount it while open; on unmount focus returns to the element that had it.
 *  open.value ? h(Dialog, { title: t("models.add"), onClose: () => (open.value = false), actions: h("button", ...) }, body) : null */
export function Dialog({ title, onClose, actions, children }: DialogProps): View {
  const el = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = el.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return h("dialog", {
    ref: el, class: "dialog", "aria-labelledby": titleId,
    onKeyDown: (e: KeyboardEvent) => {
      // The native modal keeps the page inert but lets Tab walk out to the browser chrome; wrap it inside instead.
      if (e.key !== "Tab") return;
      const focusable = Array.from(el.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === el.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    },
    onCancel: (e: Event) => { e.preventDefault(); onClose(); },
    onClick: (e: MouseEvent) => { if (e.target === el.current) onClose(); },
  },
    h("div", { class: "dialog-body" },
      h("div", { class: "dialog-head" },
        h("h2", { id: titleId }, title),
        h("button", { type: "button", class: "icon-btn", onClick: onClose }, icon("close"), h("span", { class: "sr-only" }, t("dialog.close")))),
      h("div", { class: "dialog-content" }, children),
      actions ? h("div", { class: "dialog-actions" }, actions) : null));
}
