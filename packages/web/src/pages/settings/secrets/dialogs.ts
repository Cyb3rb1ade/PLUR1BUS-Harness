// Create / rotate dialog for a secret (value, plus an optional one-line description of what it is for: plain metadata, kept apart from the value). The value lives ONLY in the uncontrolled password input: no state, no signal, no
// `value` attribute. On submit it is read once, the input is emptied before anything is awaited, and the local goes out of
// scope when `onSave` settles. The reveal toggle is dialog-local and resets on submit and on close.
// Rotating asks once more before anything is sent: the first Save only validates and shows the question (the value stays in
// the read-only input meanwhile), the second one sends.
import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Dialog } from "../../../components/dialog.ts";
import { t } from "../../../i18n.ts";
import { bad, Field } from "../../common/field.ts";

/** The names the secret store accepts. */
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
/** The longest description the core accepts (characters). */
export const SECRET_DESCRIPTION_MAX = 200;
export type SaveResult = { ok: true } | { ok: false; message: string };

export type SecretDialogProps = {
  /** Rotate: the existing secret's name (fixed). Create: omitted. */
  rotate?: string;
  existing: readonly string[];
  /** Rotate: the description stored now, shown in the field. */
  description?: string | undefined;
  /** Sends the RPC. Receives the value as an argument only; must not keep it. `description` is given only when it differs
   *  from what is stored: a rotation that leaves the text alone sends none (the core keeps it), an emptied one sends "". */
  onSave: (name: string, value: string, description?: string) => Promise<SaveResult>;
  onClose: () => void;
};

export function SecretDialog({ rotate, existing, description: stored, onSave, onClose }: SecretDialogProps): View {
  const value = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(rotate ?? "");
  const [about, setAbout] = useState(stored ?? "");
  const [nameErr, setNameErr] = useState("");
  const [valueErr, setValueErr] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy) return;
    const input = value.current;
    const nErr = rotate !== undefined ? "" : !SECRET_NAME.test(name) ? t("secrets.err.name") : existing.includes(name) ? t("secrets.err.exists") : "";
    const vErr = input && input.value.length > 0 ? "" : t("secrets.err.value");
    setNameErr(nErr); setValueErr(vErr); setSaveErr("");
    if (nErr || vErr || !input) return;
    if (rotate !== undefined && !confirming) { setConfirming(true); setReveal(false); return; }
    const secret = input.value;
    input.value = ""; setReveal(false); setConfirming(false); setBusy(true);
    let r: SaveResult;
    const text = about.trim();
    const sent = text === (stored ?? "") ? undefined : text;
    try { r = await (sent === undefined ? onSave(rotate ?? name, secret) : onSave(rotate ?? name, secret, sent)); } catch { r = { ok: false, message: t("secrets.err.save") }; }
    if (r.ok) { onClose(); return; }
    setSaveErr(r.message); setBusy(false);
  };

  const title = rotate !== undefined ? t("secrets.rotate.title", { name: rotate }) : t("secrets.create.title");
  return h(Dialog, {
    title, onClose,
    actions: [
      h("button", { key: "c", type: "button", class: "btn btn-quiet", onClick: onClose }, t("secrets.cancel")),
      confirming ? h("button", { key: "b", type: "button", class: "btn", disabled: busy, onClick: () => { setConfirming(false); } }, t("secrets.back")) : null,
      h("button", { key: "s", type: "submit", form: "secret-form", class: "btn btn-primary", disabled: busy, "aria-disabled": busy },
        busy ? t("secrets.saving") : confirming ? t("secrets.rotate.confirm") : t("secrets.save")),
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
          readOnly: confirming,
          "aria-describedby": valueErr ? "secret-value-err" : "secret-value-hint", ...(valueErr ? { "aria-invalid": true } : {}) })),
      h("label", { class: "check" },
        h("input", { type: "checkbox", checked: reveal, onChange: (e: Event) => { setReveal((e.target as HTMLInputElement).checked); } }), " ", t("secrets.reveal")),
      h(Field, { id: "secret-about", label: t("secrets.field.description"), hint: t("secrets.field.description.hint") },
        h("input", { id: "secret-about", type: "text", autocomplete: "off", maxLength: SECRET_DESCRIPTION_MAX, name: "secret-about", value: about, readOnly: confirming,
          "aria-describedby": "secret-about-hint", onInput: (e: Event) => { setAbout((e.target as HTMLInputElement).value); } })),
      confirming && rotate !== undefined ? h("p", { class: "secret-confirm", role: "status" }, t("secrets.rotate.confirmText", { name: rotate })) : null,
      saveErr ? h("p", { class: "form-error", role: "alert" }, saveErr) : null));
}
