export const pairingErrors = ["rate-limited", "second-factor-required", "cli-missing", "denied", "insecure-origin", "installation-mismatch", "incompatible", "network", "trust-unavailable", "revoked", "keychain-memory-only", "keychain-denied", "keychain-unavailable", "keychain-error", "cert-changed", "ca-untrusted", "untrusted", "proof-mismatch", "unauthorized", "protocol", "invalid", "storage", "pairing-needed", "timeout"] as const;
export type PairingError = typeof pairingErrors[number];
/** Current CLI device codes and older eight-character offers remain distinct, bounded formats. */
export function pairingCode(first: string, second: string, complete: string): string | null {
    if (complete) return /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$(?![\s\S])/.test(complete) ? complete : null;
    return /^[0-9A-HJKMNP-TV-Z]{4}$(?![\s\S])/.test(first) && /^[0-9A-HJKMNP-TV-Z]{4}$(?![\s\S])/.test(second)
        ? `${first}-${second}` : null;
}
export type PairingState = {
    phase: "idle" | "pairing" | "paired";
} | {
    phase: "error";
    error: PairingError;
    versions?: { server: string; client: string };
    retry: "code" | "repair" | "retry";
};
export function pairingFailure(error: unknown): Extract<PairingState, {
    phase: "error";
}> {
    if (typeof error === "string" && /^rate-limited:(?:[1-9]|[1-5][0-9]|60)$/.test(error)) return {phase:"error",error:"rate-limited",retry:"retry"};
    const versions = typeof error === "string" ? /^incompatible:([0-9.]{1,32}):([0-9.]{1,32})$/.exec(error) : null;
    if (versions) return { phase: "error", error: "incompatible", retry: "retry", versions: { server: versions[1]!, client: versions[2]! } };
    const kind = pairingErrors.includes(error as PairingError) ? error as PairingError : "network";
    return { phase: "error", error: kind, retry: ["cli-missing", "denied"].includes(kind) ? "code" : ["revoked", "cert-changed", "ca-untrusted", "pairing-needed"].includes(kind) ? "repair" : "retry" };
}
export function transition(state: PairingState, action: "start" | "success" | "reset" | PairingError): PairingState {
    if (action === "start")
        return { phase: "pairing" };
    if (action === "reset")
        return { phase: "idle" };
    if (action === "success")
        return state.phase === "pairing" ? { phase: "paired" } : state;
    return pairingFailure(action);
}
