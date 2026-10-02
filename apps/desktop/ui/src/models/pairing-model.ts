export const pairingErrors = ["cli-missing", "denied", "insecure-origin", "installation-mismatch", "incompatible", "network", "revoked", "keychain-memory-only", "cert-changed", "ca-untrusted", "untrusted", "proof-mismatch", "unauthorized", "protocol", "invalid", "storage", "pairing-needed"] as const;
export type PairingError = typeof pairingErrors[number];
export type PairingState = {
    phase: "idle" | "pairing" | "paired";
} | {
    phase: "error";
    error: PairingError;
    retry: "code" | "repair" | "retry";
};
export function pairingFailure(error: unknown): Extract<PairingState, {
    phase: "error";
}> {
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
