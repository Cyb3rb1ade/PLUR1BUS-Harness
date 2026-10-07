import { h, type ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../view.ts";
import { t } from "../i18n.ts";
import { Dialog } from "./dialog.ts";

export type ConfirmResult = { ok: true } | { ok: false; message: string };

export type ConfirmDialogProps = {
  title: string;
  /** What is about to happen, in words (a paragraph or a list). */
  children?: ComponentChildren;
  confirmLabel: string;
  /** A destructive action: the confirm button gets the danger look. */
  danger?: boolean;
  /** Identity-bound confirmation: the confirm button stays disabled until this exact text is typed (an agent's or secret's name). */
  expected?: string;
  /** Runs when the person confirms. Resolve `{ ok: true }` to finish (the dialog calls `onClose`), or `{ ok: false, message }` to stay open and show the message. */
  onConfirm: () => Promise<ConfirmResult>;
  onClose: () => void;
};

/** Confirmation before a risky action: says what happens, optionally asks for the target's name to be typed, shows the failure inline
 *  and keeps itself open until the action succeeded. Mount it while open (like `Dialog`). */
export function ConfirmDialog({ title, children, confirmLabel, danger = false, expected, onConfirm, onClose }: ConfirmDialogProps): View {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const matches = expected === undefined || typed === expected;

  const run = async (): Promise<void> => {
    if (busy || !matches) return;
    setBusy(true); setError("");
    let r: ConfirmResult;
    try { r = await onConfirm(); } catch { r = { ok: false, message: t("shared.confirm.failed") }; }
    if (r.ok) { onClose(); return; }
    setError(r.message); setBusy(false);
  };

  return h(Dialog, {
    title, onClose,
    actions: [
      h("button", { key: "cancel", type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
      h("button", { key: "go", type: "button", class: danger ? "btn btn-danger" : "btn btn-primary", disabled: !matches || busy, "aria-disabled": !matches || busy, onClick: () => { void run(); } }, busy ? t("shared.confirm.working") : confirmLabel),
    ],
  },
    h("div", { class: "confirm-body" }, children),
    expected !== undefined
      ? h("div", { class: "field" },
        h("label", { for: "confirm-typed" }, t("shared.confirm.typeLabel", { value: expected })),
        h("input", { id: "confirm-typed", type: "text", autocomplete: "off", spellcheck: false, value: typed, onInput: (e: Event) => { setTyped((e.target as HTMLInputElement).value); } }),
        typed !== "" && !matches ? h("p", { class: "form-error", role: "status" }, t("shared.confirm.mismatch")) : null)
      : null,
    error ? h("p", { class: "form-error", role: "alert" }, error) : null);
}
