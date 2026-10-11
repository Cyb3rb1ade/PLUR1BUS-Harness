// Invite dialog: name, role preset, validity (1 h, 24 h, 7 d, 30 d or custom up to 30 days) and per-agent rights.
// Calls user.invite.create and shows the generated one-time link exactly once, with a copy button. The link lives only in this
// component's state: closing the dialog drops it. Against a harness that returns only the pairing code, the code is shown instead.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Dialog } from "../../../components/dialog.ts";
import { formatDateTime, t, type Key } from "../../../i18n.ts";
import { bad, Field } from "../../common/field.ts";
import type { Rights, TtlChoice } from "./model.ts";
import { createInvite, DEFAULT_TTL, NAME_MAX, TTL_MAX_HOURS, TTL_PRESETS, ttlMinutes, validateName } from "./model.ts";
import { RightsMatrix } from "./rights.ts";

const ROLES = ["admin", "operator", "member", "viewer"] as const;

export function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }): View {
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");
  const [rights, setRights] = useState<Rights>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ttl, setTtl] = useState<TtlChoice>(DEFAULT_TTL);
  const [customHours, setCustomHours] = useState("");
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameError = touched && !validateName(name) ? t("users.invite.nameError") : undefined;
  const minutes = ttlMinutes(ttl, customHours);
  const ttlError = touched && minutes === null ? t("users.invite.ttlError", { max: TTL_MAX_HOURS }) : undefined;

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setTouched(true);
    if (!validateName(name) || minutes === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createInvite(name.trim(), role, "web", minutes);
      if (res.link) setCreatedLink(res.link);
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
    const secret = createdLink ?? createdCode;
    if (!secret) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(secret);
        setCopied(true);
        setTimeout(() => { setCopied(false); }, 2000);
      }
    } catch {
      // Fallback if clipboard API is restricted
    }
  };

  if (createdCode) {
    const shown = createdLink ?? createdCode;
    return h(Dialog, {
      title: t("users.invites.created"),
      onClose,
      actions: [
        h("button", { key: "close", type: "button", class: "btn btn-primary", onClick: onClose }, t("dialog.close")),
      ],
    },
      h("div", { class: "invite-success" },
        h("p", { class: "lead" }, createdLink ? t("users.invites.linkOnce") : t("users.invites.codeOnce")),
        h("div", { class: "invite-code-box" },
          createdLink
            ? h("input", { class: "invite-code invite-link", type: "text", readOnly: true, value: createdLink, "aria-label": t("users.invites.link"), onFocus: (e: Event) => { (e.target as HTMLInputElement).select(); } })
            : h("code", { class: "invite-code", "data-code": createdCode }, createdCode),
          h("button", {
            type: "button",
            class: "btn btn-secondary",
            onClick: copyCode,
            "aria-label": createdLink ? t("users.invites.copyLink") : t("users.invites.copy"),
          }, copied ? t("users.invites.copied") : createdLink ? t("users.invites.copyLink") : t("users.invites.copy"))),
        shown && expiresAt ? h("p", { class: "field-hint" }, t("users.invites.expires", { when: formatDateTime(new Date(expiresAt)) })) : null));
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
      h(Field, { id: "users-invite-ttl", label: t("users.invite.validity"), hint: t("users.invite.validityHint") },
        h("select", { id: "users-invite-ttl", value: ttl, onChange: (e: Event) => { setTtl((e.target as HTMLSelectElement).value as TtlChoice); } },
          TTL_PRESETS.map((p) => h("option", { key: p.id, value: p.id, selected: p.id === ttl }, t(`users.invite.ttl.${p.id}` as Key))),
          h("option", { key: "custom", value: "custom", selected: ttl === "custom" }, t("users.invite.ttl.custom")))),
      ttl === "custom"
        ? h(Field, { id: "users-invite-ttl-hours", label: t("users.invite.customHours", { max: TTL_MAX_HOURS }), error: ttlError },
          h("input", { id: "users-invite-ttl-hours", type: "text", inputMode: "numeric", value: customHours, maxLength: 3, autocomplete: "off", onInput: (e: Event) => { setCustomHours((e.target as HTMLInputElement).value); }, onBlur: () => { setTouched(true); }, ...bad(ttlError, "users-invite-ttl-hours") }))
        : null,
      role === "member" || role === "operator" ? h(RightsMatrix, { role, rights, onChange: setRights, idPrefix: "users-invite" }) : h("p", { class: "field-hint" }, t("users.rights.byRole")),
      error ? h("p", { class: "form-notice", role: "status" }, error) : null));
}
