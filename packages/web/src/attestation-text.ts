import { t, type Key } from "./i18n.ts";

const METHODS: Readonly<Record<string, Key>> = {
  "touch-id": "approvals.attest.method.touchId",
  "macos-password": "approvals.attest.method.macosPassword",
  "windows-hello": "approvals.attest.method.windowsHello",
  "uac": "approvals.attest.method.uac",
  "polkit": "approvals.attest.method.polkit",
};

const FAILURES: Readonly<Record<string, Key>> = {
  cancelled: "approvals.attest.cancelled",
  timeout: "approvals.attest.timeout",
};

/**
 * The sentence for an `approval.decide` refusal that is about the OS confirmation (core: `attestation-required` with the method in
 * `detail`, `attestation-failed` with the outcome in `detail`, `attestation-unavailable`, `attestation-in-progress`), or `null` when
 * the refusal is about something else. The method is looked up, never interpolated from the wire.
 */
export function attestationText(e: { error: string | null; reason: string | undefined; detail?: string | undefined }): string | null {
  switch (e.reason) {
    case "attestation-required":
      return t("approvals.attest.required", { method: t(METHODS[e.detail ?? ""] ?? "approvals.attest.method.system") });
    case "attestation-failed":
      return t(FAILURES[e.detail ?? ""] ?? "approvals.attest.failed");
    case "attestation-unavailable":
      return t("approvals.attest.unavailable");
    case "attestation-in-progress":
      return t("approvals.attest.inProgress");
    default:
      return null;
  }
}
