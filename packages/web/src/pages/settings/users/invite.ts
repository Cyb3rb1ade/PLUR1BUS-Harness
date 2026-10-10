// Invite dialog: name, role preset and per-agent rights.
// Calls user.invite.create, displays the generated one-time code and allows copying it.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Dialog } from "../../../components/dialog.ts";
import { formatDateTime, t, type Key } from "../../../i18n.ts";
import { bad, Field } from "../../common/field.ts";
import type { Rights } from "./model.ts";
import { createInvite, NAME_MAX, validateName } from "./model.ts";
import { RightsMatrix } from "./rights.ts";

const ROLES = ["admin", "operator", "member", "viewer"] as const;

export function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }): View {
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");
  const [rights, setRights] = useState<Rights>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameError = touched && !validateName(name) ? t("users.invite.nameError") : undefined;

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setTouched(true);
    if (!validateName(name) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createInvite(name.trim(), role, "web");
      setCreatedCode(res.code);
      setExpiresAt(res.expiresAt);
      onCreated?.();
    } catch (err: unknown) {
      const o = err as { kind?: string; errorCode?: string; message?: string; code?: number };
      if (o.kind === "unavailable" || o.errorCode === "E_NOT_AVAILABLE" || o.code === -32601) {
        setError(t("users.invite.unavailable"));
      } else {
        setError(o.message ?? t("users.invite.unavailable"));
      }
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async (): Promise<void> => {
    if (!createdCode) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(createdCode);
        setCopied(true);
        setTimeout(() => { setCopied(false); }, 2000);
      }
    } catch {
      // Fallback if clipboard API is restricted
    }
  };

  if (createdCode) {
    return h(Dialog, {
      title: t("users.invites.created"),
      onClose,
      actions: [
        h("button", { key: "close", type: "button", class: "btn btn-primary", onClick: onClose }, t("dialog.close")),
      ],
    },
      h("div", { class: "invite-success" },
        h("p", { class: "lead" }, t("users.invites.codeOnce")),
        h("div", { class: "invite-code-box" },
          h("code", { class: "invite-code", "data-code": createdCode }, createdCode),
          h("button", {
            type: "button",
            class: "btn btn-secondary",
            onClick: copyCode,
            "aria-label": t("users.invites.copy"),
          }, copied ? t("users.invites.copied") : t("users.invites.copy"))),
        expiresAt ? h("p", { class: "field-hint" }, t("users.invites.expires", { when: formatDateTime(new Date(expiresAt)) })) : null));
  }

  return h(Dialog, {
    title: t("users.invite.title"), onClose,
    actions: [
      h("button", { key: "cancel", type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
      h("button", { key: "go", type: "submit", form: "users-invite-form", class: "btn btn-primary", disabled: busy }, t("users.invite.submit")),
    ],
  },
    h("form", { id: "users-invite-form", noValidate: true, onSubmit: (e: Event) => { void submit(e); } },
      h("p", { class: "lead" }, t("users.invite.lead")),
      h(Field, { id: "users-invite-name", label: t("users.invite.name"), hint: t("users.invite.nameHint"), error: nameError },
        h("input", { id: "users-invite-name", type: "text", value: name, maxLength: NAME_MAX + 50, required: true, autocomplete: "off", onInput: (e: Event) => { setName((e.target as HTMLInputElement).value); }, onBlur: () => { setTouched(true); }, ...bad(nameError, "users-invite-name") })),
      h(Field, { id: "users-invite-role", label: t("users.invite.role"), hint: t("users.invite.ownerNote") },
        h("select", { id: "users-invite-role", value: role, onChange: (e: Event) => { setRole((e.target as HTMLSelectElement).value as (typeof ROLES)[number]); setRights({}); } },
          ROLES.map((r) => h("option", { key: r, value: r, selected: r === role }, t(`users.preset.${r}.name` as Key))))),
      h("p", { class: "field-hint" }, t(`users.preset.${role}.summary` as Key)),
      role === "member" || role === "operator" ? h(RightsMatrix, { role, rights, onChange: setRights, idPrefix: "users-invite" }) : h("p", { class: "field-hint" }, t("users.rights.byRole")),
      error ? h("p", { class: "form-notice", role: "status" }, error) : null));
}
