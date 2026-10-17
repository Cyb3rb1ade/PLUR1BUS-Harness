// Defence in depth for the approval details. The core redacts `targets` and `summary` before they leave it, but a redactor that
// works on exact values cannot know a value it was never given, and `agentReason` is the model's own text. What still looks like
// a credential is hidden here, so a screen share or a screenshot of the approval never carries one. The action stays readable:
// only the value goes, never the flag, header or variable that names it. Text the server already redacted (`[REDACTED:…]`)
// is left alone, and the function is idempotent.

const HIDDEN = "[hidden]";
const NAMES = "token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization";

const RULES: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi, `$1${HIDDEN}$2`],
  // A word of prose ("Bearer authentication") is not a credential: it must carry a digit or one of . _ ~ + / = -.
  [/\b(Bearer|Basic)\s+(?!\[)(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`],
  // --password hunter2, --api-key=abc, --token "a b"
  [new RegExp(`(--?[\\w-]*(?:${NAMES.replace("authorization", "auth")})[\\w-]*)(\\s+|=)(?!\\[|-)("[^"]*"|'[^']*'|\\S+)`, "gi"), `$1$2${HIDDEN}`],
  // API_TOKEN=abc, access_key=abc&x=1, "client_secret": "abc", password: abc
  [new RegExp(`(\\b[\\w.-]*(?:${NAMES})[\\w.-]*["']?\\s*[=:]\\s*["']?)(?!\\[|Bearer\\b|Basic\\b)[^\\s"'&;,)}\\]]+`, "gi"), `$1${HIDDEN}`],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, HIDDEN],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, HIDDEN],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, HIDDEN],
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}
