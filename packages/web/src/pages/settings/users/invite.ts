// Invite dialog: name, role preset and per-agent rights. Validated, then it ends in an explicit "not available" message: no
// RPC creates a person with a role (docs/web-ui.md F40), so nothing is sent.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Dialog } from "../../../components/dialog.ts";
import { t, type Key } from "../../../i18n.ts";
import { bad, Field } from "../../common/field.ts";
import type { Rights } from "./model.ts";
import { NAME_MAX, validateName } from "./model.ts";
import { RightsMatrix } from "./rights.ts";

const ROLES = ["admin", "operator", "member", "viewer"] as const;

export function InviteDialog({ onClose }: { onClose: () => void }): View {
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");
  const [rights, setRights] = useState<Rights>({});
  const [touched, setTouched] = useState(false);
  const [done, setDone] = useState(false);
  const nameError = touched && !validateName(name) ? t("users.invite.nameError") : undefined;

  const submit = (e: Event): void => {
    e.preventDefault();
    setTouched(true);
    if (validateName(name)) setDone(true);
  };

  return h(Dialog, {
    title: t("users.invite.title"), onClose,
    actions: [
      h("button", { key: "cancel", type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
      h("button", { key: "go", type: "submit", form: "users-invite-form", class: "btn btn-primary" }, t("users.invite.submit")),
    ],
  },
    h("form", { id: "users-invite-form", noValidate: true, onSubmit: submit },
      h("p", { class: "lead" }, t("users.invite.lead")),
      h(Field, { id: "users-invite-name", label: t("users.invite.name"), hint: t("users.invite.nameHint"), error: nameError },
        h("input", { id: "users-invite-name", type: "text", value: name, maxLength: NAME_MAX + 50, required: true, autocomplete: "off", onInput: (e: Event) => { setName((e.target as HTMLInputElement).value); setDone(false); }, onBlur: () => { setTouched(true); }, ...bad(nameError, "users-invite-name") })),
      h(Field, { id: "users-invite-role", label: t("users.invite.role"), hint: t("users.invite.ownerNote") },
        h("select", { id: "users-invite-role", value: role, onChange: (e: Event) => { setRole((e.target as HTMLSelectElement).value as (typeof ROLES)[number]); setRights({}); setDone(false); } },
          ROLES.map((r) => h("option", { key: r, value: r, selected: r === role }, t(`users.preset.${r}.name` as Key))))),
      h("p", { class: "field-hint" }, t(`users.preset.${role}.summary` as Key)),
      role === "member" || role === "operator" ? h(RightsMatrix, { role, rights, onChange: setRights, idPrefix: "users-invite" }) : h("p", { class: "field-hint" }, t("users.rights.byRole")),
      done ? h("p", { class: "form-notice", role: "status" }, t("users.invite.unavailable")) : null));
}
