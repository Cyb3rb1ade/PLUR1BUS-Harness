/** Function-specific consent metadata. It never changes the separate runtime privacy pin. */
export interface PrivacyAcknowledgment {
    provider: string;
    acknowledgedAt: string;
    by: string;
    endpoint?: string;
}
export interface PrivacyChoice {
    function: "text" | "media" | "caption";
    provider: string;
    local: boolean;
    pinned?: boolean;
    /** The exact endpoint the admitted provider uses, when it is configurable. */
    endpoint?: string;
    ack?: PrivacyAcknowledgment | undefined;
}
export interface PrivacyAcknowledgmentFailure {
    code: "E_MEDIA_PRIVACY" | "E_DENIED";
    reason: "privacy-pin" | "privacy-acknowledgment-required" | "privacy-acknowledgment-invalid" | "privacy-acknowledgment-mismatch";
}
export function privacyAcknowledgmentError(choice: PrivacyChoice): PrivacyAcknowledgmentFailure | null {
    if (choice.local)
        return null;
    const code = choice.function === "text" ? "E_DENIED" : "E_MEDIA_PRIVACY";
    if (choice.pinned)
        return { code, reason: "privacy-pin" };
    const ack = choice.ack;
    if (!ack)
        return { code, reason: "privacy-acknowledgment-required" };
    if (typeof ack.by !== "string" || !ack.by.trim() || typeof ack.acknowledgedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(ack.acknowledgedAt) || !Number.isFinite(Date.parse(ack.acknowledgedAt)))
        return { code, reason: "privacy-acknowledgment-invalid" };
    if (ack.provider !== choice.provider || (ack.endpoint ?? null) !== (choice.endpoint ?? null))
        return { code, reason: "privacy-acknowledgment-mismatch" };
    return null;
}
