/**
 * Defence in depth for text that reaches the DOM or the clipboard from outside the shell (container log tails,
 * crash and upgrade diagnostics). The native side redacts what it persists, but `harness_logs_tail` returns
 * raw container output, so the UI masks home-directory user names, credentials and long opaque runs itself.
 * Digests (`sha256:` plus hex) and short numeric facts stay readable.
 */
const MASK = "[redacted]";
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`],
  [/(\bauthorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi, `$1${MASK}`],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/(\b[\w-]*(?:token|secret|password|passwd|apikey|api[_-]key|credential)s?["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, `$1${MASK}`],
  [/(?<!sha256:)(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, MASK],
  [/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/gi, "~"],
  [/(?<![\w.~-])\/(?:Users|home)\/[^/\s"':]+/g, "~"],
];
export function redactDiagnostics(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
/** Redact first, then keep the newest `max` characters, so a secret cut by the window is never half shown. */
export function redactedTail(text: string, max = 65536): string {
  const redacted = redactDiagnostics(text);
  return redacted.length > max ? redacted.slice(-max) : redacted;
}
