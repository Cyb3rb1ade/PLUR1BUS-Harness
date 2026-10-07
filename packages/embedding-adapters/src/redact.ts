// Secret redaction for everything an adapter can surface (error messages, logs, diagnostics).
//
// Two layers: (1) the exact secret values the adapter itself resolved, removed literally and in the URL-encoded and
// JSON-escaped spellings a server may echo them in; (2) defence-in-depth patterns for credentials a server echoes that
// the adapter never saw (a key quoted in a 401 body, a token in a redirect Location). Layer 1 is the guarantee,
// layer 2 is best effort.

const MASK = "[redacted]";
/** Secrets shorter than this are not valid credentials and would shred ordinary text, so they are not matched literally. */
const MIN_LITERAL_SECRET = 4;

const SENSITIVE_QUERY_KEY = /^(?:key|api[-_]?key|apikey|token|access[-_]?token|auth|authorization|secret|sig|signature)$/i;

const PATTERNS: readonly [RegExp, string][] = [
  // Authorization schemes.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, `$1 ${MASK}`],
  // key=value / "key": "value" / header: value pairs.
  [/\b((?:x-)?(?:goog-)?api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|secret|token|password|key)(["']?\s*[:=]\s*["']?)([^\s"',&;]{4,})/gi, `$1$2${MASK}`],
  // Vendor token shapes: OpenAI-style sk-/pk-/rk-, Google AIza, GitHub, Slack, JWT, Jina, Voyage.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, MASK],
  [/\b(?:jina_|pa-)[A-Za-z0-9_-]{16,}/g, MASK],
  // Long opaque alphanumeric runs (Cohere-style 40 character keys).
  [/\b[A-Za-z0-9]{40,}\b/g, MASK],
  // user:password@ in a URL authority.
  [/(\bhttps?:\/\/)[^\s\/@:]+(?::[^\s\/@]*)?@/gi, `$1${MASK}@`],
  // Sensitive query parameters.
  [/([?&](?:key|api[-_]?key|apikey|token|access_token|auth|authorization|secret|sig|signature)=)[^&\s"']+/gi, `$1${MASK}`],
];

function literalVariants(secret: string): string[] {
  const out = new Set<string>();
  if (secret.length < MIN_LITERAL_SECRET) return [];
  out.add(secret);
  out.add(encodeURIComponent(secret));
  out.add(JSON.stringify(secret).slice(1, -1));
  return [...out].filter((v) => v.length >= MIN_LITERAL_SECRET);
}

/** Removes the given secret values (literally, URL-encoded, JSON-escaped) and credential-shaped substrings. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  const literals = secrets.flatMap(literalVariants).sort((a, b) => b.length - a.length);
  for (const lit of literals) out = out.split(lit).join(MASK);
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** A URL safe to put in a message: no userinfo, no fragment, sensitive query values masked. Non-URLs fall back to redactSecrets. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_QUERY_KEY.test(k)) u.searchParams.set(k, MASK);
    return u.toString();
  } catch {
    return redactSecrets(raw);
  }
}
