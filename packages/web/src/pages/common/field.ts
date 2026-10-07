import { h, type ComponentChildren } from "preact";
import type { View } from "../../view.ts";

/** A labelled form field with an optional error line; wire the control with `bad(error, id)` so assistive technology reads the error.
 *  h(Field, { id: "name", label: t("agents.name"), error }, h("input", { id: "name", ...bad(error, "name") })) */
export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string | undefined; hint?: string | undefined; children?: ComponentChildren }): View {
  return h("div", { class: "field" },
    h("label", { for: id }, label),
    children,
    hint ? h("p", { class: "field-hint", id: `${id}-hint` }, hint) : null,
    error ? h("p", { class: "form-error", id: `${id}-err` }, error) : null);
}

/** aria attributes for a control whose Field shows `error`. */
export const bad = (error: string | undefined, id: string): Record<string, unknown> => (error ? { "aria-invalid": true, "aria-describedby": `${id}-err` } : {});
