/** Content-Security-Policy of every response (ADR-004 *CSP*). Every response is JSON in this slice, so nothing may load
 *  or run anything: no `script-src` at all (no inline script, no nonce — the per-response nonce arrives with the SPA
 *  that needs one, ruling R4), `frame-ancestors 'none'`, no base URI, no form target. */
export const CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The headers added to every response, error responses and the responses written for malformed requests included.
 *  `Strict-Transport-Security` only when the listener is TLS (a browser ignores it over plain HTTP, and a stale
 *  loopback pin would be a nuisance). */
export function securityHeaders(tls: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cache-Control": "no-store",
    ...(tls ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}
