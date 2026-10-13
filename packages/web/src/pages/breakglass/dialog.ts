import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Dialog } from "../../components/dialog.ts";
import { bad, Field } from "../common/field.ts";
import { t } from "../../i18n.ts";
import { getApi } from "../common/load.ts";
import "./rpc-types.ts";
import type { BreakglassRequestResult } from "./rpc-types.ts";

export const BG_REASON_MIN = 10;
export const BG_REASON_MAX = 500;
export const BG_TTL_DEFAULT = 15;

export function validateReason(raw: string): "ok" | "short" | "long" {
  const n = raw.trim().length;
  if (n < BG_REASON_MIN) return "short";
  if (n > BG_REASON_MAX) return "long";
  return "ok";
}

export type RequestBreakglassDialogProps = {
  onClose: () => void;
  onSuccess: (result: BreakglassRequestResult) => void;
};

export function RequestBreakglassDialog({ onClose, onSuccess }: RequestBreakglassDialogProps): View {
  const [targetUserId, setTargetUserId] = useState("");
  const [reason, setReason] = useState("");
  const [windowMinutes, setWindowMinutes] = useState(String(BG_TTL_DEFAULT));
  const [confirmed, setConfirmed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  // A request is one audited grant and one notice to the person concerned. `busy` is read from the render a handler was created in, so two
  // submits in the same task would both pass it; this ref is set synchronously.
  const inFlight = useRef(false);

  const targetValid = targetUserId.trim().length > 0;
  const reasonValidation = validateReason(reason);
  const targetError = touched && !targetValid ? t("breakglass.dialog.errorTarget") : undefined;
  const reasonError = touched && reasonValidation !== "ok"
    ? t(reasonValidation === "short" ? "breakglass.dialog.errorReasonShort" : "breakglass.dialog.errorReasonLong")
    : undefined;
  const confirmError = touched && !confirmed ? t("breakglass.dialog.errorConfirm") : undefined;

  const handleSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setTouched(true);
    if (!targetValid || reasonValidation !== "ok" || !confirmed || busy || inFlight.current) return;

    inFlight.current = true;
    setBusy(true);
    setServerError("");
    try {
      const res = await getApi().rpc("breakglass.request", {
        targetUserId: targetUserId.trim(),
        reason: reason.trim(),
        windowMinutes: Number(windowMinutes),
      });
      setBusy(false);
      onSuccess(res);
      onClose();
    } catch (err: unknown) {
      inFlight.current = false;
      setBusy(false);
      const o = (typeof err === "object" && err !== null ? err : {}) as { kind?: string; errorCode?: string; message?: string; code?: number };
      if (o.kind === "forbidden" || o.errorCode === "E_DENIED") {
        setServerError(t("breakglass.error.denied"));
      } else if (o.kind === "unavailable" || o.errorCode === "E_NOT_AVAILABLE" || o.code === -32601) {
        setServerError(t("breakglass.error.unavailable"));
      } else {
        setServerError(o.message ? t("breakglass.error.failed", { message: o.message }) : t("breakglass.error.generic"));
      }
    }
  };

  return h(
    Dialog,
    {
      title: t("breakglass.dialog.title"),
      onClose,
      actions: h(
        "div",
        { class: "bg-dialog-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
        h(
          "button",
          {
            type: "submit",
            form: "bg-request-form",
            class: "btn btn-primary",
            disabled: busy,
          },
          busy ? t("breakglass.dialog.submitting") : t("breakglass.dialog.submit"),
        ),
      ),
    },
    h(
      "form",
      { id: "bg-request-form", class: "bg-dialog-form", noValidate: true, onSubmit: (e: Event) => { void handleSubmit(e); } },
      h("p", { class: "lead" }, t("breakglass.dialog.lead")),
      h(
        Field,
        { id: "bg-target-user", label: t("breakglass.dialog.target"), error: targetError, hint: t("breakglass.dialog.targetHint") },
        h("input", {
          id: "bg-target-user",
          type: "text",
          value: targetUserId,
          placeholder: t("breakglass.dialog.targetPlaceholder"),
          required: true,
          onInput: (e: Event) => { setTargetUserId((e.target as HTMLInputElement).value); },
          onBlur: () => { setTouched(true); },
          ...bad(targetError, "bg-target-user"),
        }),
      ),
      h(
        Field,
        { id: "bg-reason", label: t("breakglass.dialog.reason"), error: reasonError, hint: t("breakglass.dialog.reasonHint") },
        h("textarea", {
          id: "bg-reason",
          rows: 3,
          maxLength: BG_REASON_MAX + 50,
          value: reason,
          required: true,
          onInput: (e: Event) => { setReason((e.target as HTMLTextAreaElement).value); },
          onBlur: () => { setTouched(true); },
          ...bad(reasonError, "bg-reason"),
        }),
      ),
      h(
        Field,
        { id: "bg-window", label: t("breakglass.dialog.window") },
        h(
          "select",
          {
            id: "bg-window",
            value: windowMinutes,
            onChange: (e: Event) => { setWindowMinutes((e.target as HTMLSelectElement).value); },
          },
          [1, 5, 15, 30, 60].map((n) => h("option", { key: n, value: String(n) }, t("breakglass.dialog.minutes", { n }))),
        ),
      ),
      h(
        "div",
        { class: "bg-checkbox-field" },
        h("input", {
          type: "checkbox",
          id: "bg-confirm-check",
          checked: confirmed,
          onChange: (e: Event) => { setConfirmed((e.target as HTMLInputElement).checked); },
        }),
        h("label", { for: "bg-confirm-check" }, t("breakglass.dialog.confirmCheckbox")),
      ),
      confirmError ? h("p", { class: "form-error", role: "alert" }, confirmError) : null,
      serverError ? h("p", { class: "form-error", role: "alert" }, serverError) : null,
    ),
  );
}

export type RevokeConfirmDialogProps = {
  grantId: string;
  targetUserId: string;
  onClose: () => void;
  onSuccess: (grantId: string) => void;
};

export function RevokeConfirmDialog({ grantId, targetUserId, onClose, onSuccess }: RevokeConfirmDialogProps): View {
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");

  const handleRevoke = async (): Promise<void> => {
    setBusy(true);
    setServerError("");
    try {
      await getApi().rpc("breakglass.revoke", { grantId });
      setBusy(false);
      onSuccess(grantId);
      onClose();
    } catch (err: unknown) {
      setBusy(false);
      const o = (typeof err === "object" && err !== null ? err : {}) as { message?: string };
      setServerError(o.message ? t("breakglass.error.failed", { message: o.message }) : t("breakglass.error.generic"));
    }
  };

  return h(
    Dialog,
    {
      title: t("breakglass.revoke.title"),
      onClose,
      actions: h(
        "div",
        { class: "bg-dialog-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("breakglass.revoke.cancel")),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            disabled: busy,
            onClick: () => { void handleRevoke(); },
          },
          busy ? t("breakglass.revoke.revoking") : t("breakglass.revoke.confirm"),
        ),
      ),
    },
    h(
      "div",
      { class: "dialog-content" },
      h("p", { class: "lead" }, t("breakglass.revoke.prompt", { target: targetUserId })),
      serverError ? h("p", { class: "form-error", role: "alert" }, serverError) : null,
    ),
  );
}
