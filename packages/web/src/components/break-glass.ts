import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../view.ts";
import { t } from "../i18n.ts";
import { Dialog } from "./dialog.ts";
import { bad, Field } from "../pages/common/field.ts";
import { getApi } from "../api/shared.ts";
import "../pages/common/admin-rpc.ts";

/** docs/rbac.md, Break-glass: reason 10 to 500 characters after trimming; lifetime 1 to 60 minutes, default 15. */
export const BG_REASON_MIN = 10;
export const BG_REASON_MAX = 500;
export const BG_TTL_MIN = 1;
export const BG_TTL_MAX = 60;
export const BG_TTL_DEFAULT = 15;

export type BreakGlassInput = { reason: string; ttlMinutes: number };
export type BreakGlassResult = { ok: true } | { ok: false; kind: "forbidden" | "unavailable" | "error"; message?: string };

export type BreakGlassDialogProps = {
  /** Whose private data is read (a display name), shown in the dialog. */
  targetLabel: string;
  /** The target user's id, used to call breakglass.request if onSubmit is not provided. */
  targetUserId?: string;
  /** Sends the request. If omitted and targetUserId is given, calls breakglass.request. */
  onSubmit?: (input: BreakGlassInput) => Promise<BreakGlassResult>;
  /** Called after a successful request and for Esc, Cancel and the close button. */
  onClose: () => void;
};

export function validateReason(raw: string): "ok" | "short" | "long" {
  const n = raw.trim().length;
  return n < BG_REASON_MIN ? "short" : n > BG_REASON_MAX ? "long" : "ok";
}

/** Break-glass dialog (ADR-007, acceptance 4): the reason is mandatory, the window is bounded, and the person concerned is told. */
export function BreakGlassDialog({ targetLabel, targetUserId, onSubmit, onClose }: BreakGlassDialogProps): View {
  const [reason, setReason] = useState("");
  const [ttl, setTtl] = useState(String(BG_TTL_DEFAULT));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"" | "unavailable" | "forbidden" | "error">("");
  const [message, setMessage] = useState("");

  const v = validateReason(reason);
  const reasonError = touched && v !== "ok" ? t(v === "short" ? "shared.bg.reasonShort" : "shared.bg.reasonLong") : undefined;

  const performSubmit = async (input: BreakGlassInput): Promise<BreakGlassResult> => {
    if (onSubmit) return await onSubmit(input);
    if (!targetUserId) return { ok: false, kind: "unavailable" };
    try {
      await getApi().rpc("breakglass.request", {
        targetUserId,
        reason: input.reason,
        windowMinutes: input.ttlMinutes,
      });
      return { ok: true };
    } catch (err: unknown) {
      const o = err as { kind?: string; errorCode?: string; message?: string; code?: number };
      if (o.kind === "forbidden" || o.errorCode === "E_DENIED") return { ok: false, kind: "forbidden" };
      if (o.kind === "unavailable" || o.errorCode === "E_NOT_AVAILABLE" || o.code === -32601) return { ok: false, kind: "unavailable" };
      return { ok: false, kind: "error", ...(o.message !== undefined ? { message: o.message } : {}) };
    }
  };

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setTouched(true);
    if (busy || v !== "ok") return;
    if (!onSubmit && !targetUserId) { setOutcome("unavailable"); return; }
    setBusy(true); setOutcome("");
    let r: BreakGlassResult;
    try { r = await performSubmit({ reason: reason.trim(), ttlMinutes: Number(ttl) }); } catch { r = { ok: false, kind: "error" }; }
    if (r.ok) { onClose(); return; }
    setOutcome(r.kind); setMessage(r.message ?? ""); setBusy(false);
  };

  return h(Dialog, {
    title: t("shared.bg.title"), onClose,
    actions: [
      h("button", { key: "cancel", type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
      h("button", { key: "go", type: "submit", form: "bg-form", class: "btn btn-primary", disabled: busy, "aria-disabled": busy }, t("shared.bg.submit")),
    ],
  },
    h("form", { id: "bg-form", class: "bg-form", noValidate: true, onSubmit: (e: Event) => { void submit(e); } },
      h("p", { class: "lead" }, t("shared.bg.lead")),
      h("dl", { class: "facts" }, h("div", {}, h("dt", {}, t("shared.bg.target")), h("dd", {}, targetLabel))),
      h(Field, { id: "bg-reason", label: t("shared.bg.reason"), error: reasonError },
        h("textarea", { id: "bg-reason", rows: 3, maxLength: BG_REASON_MAX + 100, value: reason, required: true, onInput: (e: Event) => { setReason((e.target as HTMLTextAreaElement).value); }, onBlur: () => { setTouched(true); }, ...bad(reasonError, "bg-reason") })),
      h(Field, { id: "bg-ttl", label: t("shared.bg.window") },
        h("select", { id: "bg-ttl", value: ttl, onChange: (e: Event) => { setTtl((e.target as HTMLSelectElement).value); } },
          [1, 5, 15, 30, 60].map((n) => h("option", { key: n, value: String(n), selected: String(n) === ttl }, t("shared.bg.minutes", { n }))))),
      h("p", { class: "form-notice", role: "note" }, t("shared.bg.notice")),
      h("p", { class: "field-hint" }, t("shared.bg.readOnly")),
      outcome === "unavailable" ? h("p", { class: "form-notice", role: "status" }, t("shared.bg.unavailable")) : null,
      outcome === "forbidden" ? h("p", { class: "form-error", role: "alert" }, t("shared.bg.denied")) : null,
      outcome === "error" ? h("p", { class: "form-error", role: "alert" }, message === "" ? t("shared.bg.failedShort") : t("shared.bg.failed", { message })) : null));
}
