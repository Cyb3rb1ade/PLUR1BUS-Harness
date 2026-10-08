// @plur1bus/remote-access: everything the harness needs so that other devices can reach it — exposure modes, TLS
// material, pairing with certificate pinning, pair-proof for typed codes, trust rollover, the client-subnet allow-list
// and the security checks. A library with injected ports (clock, exec, secret store); it opens no listener and serves
// no route. Wiring it into packages/api and the web UI is a follow-up (docs/remote-access.md).
export * from "./types.ts";
export * from "./net-address.ts";
export * from "./exposure.ts";
export * from "./tailscale.ts";
export * from "./fingerprint.ts";
export * from "./certs.ts";
export * from "./x509.ts";
export * from "./secrets.ts";
export * from "./selfsigned.ts";
export * from "./company-ca.ts";
export * from "./pair-code.ts";
export * from "./pairing.ts";
export * from "./rate-limit.ts";
export * from "./pair-proof.ts";
export * from "./trust-rollover.ts";
export * from "./pinning.ts";
export * from "./security.ts";
