// Create / rotate dialog for a secret. The value lives ONLY in the uncontrolled password input: no state, no signal, no
// `value` attribute. On submit it is read once, the input is emptied before anything is awaited, and the local goes out of
// scope when `onSave` settles. The reveal toggle is dialog-local and resets on submit and on close.
import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Dialog } from "../../../components/dialog.ts";
import { t } from "../../../i18n.ts";
import { bad, Field } from "../../common/field.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
export type SaveResult = { ok: true } | { ok: false; message: string };

export type SecretDialogProps = {
  /** Rotate: the existing secret's name (fixed). Create: omitted. */
  rotate?: string;
  existing: readonly string[];
  /** Sends the RPC. Receives the value as an argument only; must not keep it. */
  onSave: (name: string, value: string) => Promise<SaveResult>;
  onClose: () => void;
};

export function SecretDialog({ rotate, existing, onSave, onClose }: SecretDialogProps): View {
  const value = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(rotate ?? "");
  const [nameErr, setNameErr] = useState("");
  const [valueErr, setValueErr] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy) return;
    const input = value.current;
    const nErr = rotate !== undefined ? "" : !NAME.test(name) ? t("secrets.err.name") : existing.includes(name) ? t("secrets.err.exists") : "";
    const vErr = input && input.value.length > 0 ? "" : t("secrets.err.value");
    setNameErr(nErr); setValueErr(vErr); setSaveErr("");
    if (nErr || vErr || !input) return;
    const secret = input.value;
    input.value = ""; setReveal(false); setBusy(true);
    let r: SaveResult;
    try { r = await onSave(rotate ?? name, secret); } catch { r = { ok: false, message: t("secrets.err.save") }; }
    if (r.ok) { onClose(); return; }
    setSaveErr(r.message); setBusy(false);
  };

  const title = rotate !== undefined ? t("secrets.rotate.title", { name: rotate }) : t("secrets.create.title");
  return h(Dialog, {
    title, onClose,
    actions: [
      h("button", { key: "c", type: "button", class: "btn btn-quiet", onClick: onClose }, t("secrets.cancel")),
      h("button", { key: "s", type: "submit", form: "secret-form", class: "btn btn-primary", disabled: busy, "aria-disabled": busy }, busy ? t("secrets.saving") : t("secrets.save")),
    ],
  },
    h("form", { id: "secret-form", class: "secret-form", autocomplete: "off", noValidate: true, onSubmit: (e: Event) => { e.preventDefault(); void submit(); } },
      rotate !== undefined ? h("p", { class: "field-hint" }, t("secrets.rotate.note")) : null,
      rotate === undefined
        ? h(Field, { id: "secret-name", label: t("secrets.field.name"), hint: t("secrets.field.name.hint"), error: nameErr },
          h("input", { id: "secret-name", type: "text", autocomplete: "off", spellcheck: false, autocapitalize: "off", maxLength: 128, value: name, ...bad(nameErr, "secret-name"),
            "aria-describedby": nameErr ? "secret-name-err" : "secret-name-hint", onInput: (e: Event) => { setName((e.target as HTMLInputElement).value); } }))
        : null,
      h(Field, { id: "secret-value", label: rotate !== undefined ? t("secrets.field.newValue") : t("secrets.field.value"), hint: t("secrets.field.value.hint"), error: valueErr },
        h("input", { id: "secret-value", ref: value, type: reveal ? "text" : "password", autocomplete: "off", spellcheck: false, autocapitalize: "off", name: "secret-value",
          "aria-describedby": valueErr ? "secret-value-err" : "secret-value-hint", ...(valueErr ? { "aria-invalid": true } : {}) })),
      h("label", { class: "check" },
        h("input", { type: "checkbox", checked: reveal, onChange: (e: Event) => { setReveal((e.target as HTMLInputElement).checked); } }), " ", t("secrets.reveal")),
      saveErr ? h("p", { class: "form-error", role: "alert" }, saveErr) : null));
}
