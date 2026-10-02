export const pairingErrors = ["cli-missing", "denied", "insecure-origin", "installation-mismatch", "incompatible", "network", "trust-unavailable", "revoked", "keychain-memory-only", "keychain-denied", "keychain-unavailable", "keychain-error", "cert-changed", "ca-untrusted", "untrusted", "proof-mismatch", "unauthorized", "protocol", "invalid", "storage", "pairing-needed"] as const;
export type PairingError = typeof pairingErrors[number];
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
