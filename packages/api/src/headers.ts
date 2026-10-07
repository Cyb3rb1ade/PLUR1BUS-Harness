import { randomBytes } from "node:crypto";

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

/** A fresh nonce for one HTML response: 128 bits from the CSPRNG, base64. */
export const newNonce = (): string => randomBytes(16).toString("base64");

/** The policy of the app shell (ADR-004 *CSP*). Scripts run only with this response's nonce, and what they load
 *  (`strict-dynamic`) — `'self'` and any host list are ignored for scripts by design; no `unsafe-inline`, no
 *  `unsafe-eval`, no remote origin, no plugin, no base tag, no framing. Everything else is the app's own origin. */
export function htmlCsp(nonce: string): string {
  return [
    "default-src 'self'", `script-src 'nonce-${nonce}' 'strict-dynamic'`, `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
}

/** Hands the nonce to a built page without the page being touched (packages/web is not changed for this): every
 *  `<script>` and `<style>` tag that does not carry a nonce gets this one, and the placeholder `__CSP_NONCE__` (for a
 *  template that wants it in a meta tag or a hand-written attribute) is replaced. */
export function injectNonce(html: string, nonce: string): string {
  return html
    .replace(/<(script|style)(?![^>]*\snonce\s*=)(?=[\s>])/gi, (_m, tag: string) => `<${tag} nonce="${nonce}"`)
    .replaceAll("__CSP_NONCE__", nonce);
}
