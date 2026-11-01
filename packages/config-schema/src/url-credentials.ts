// Browser-safe endpoint policy: keep public host/path material and conceal credential components.
import { looksLikePastedKey, type SecretReferencePolicy } from "./secret-reference.ts";
const MASK = "••••";

/** WHATWG removes only ASCII C0/space at the edges; two pointers keep adversarial whitespace linear. */
export function trimUrlControls(value: string): string {
  let start = 0, end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

/** Boundaries avoid treating ordinary labels such as monkey/design as credential names. */
export function credentialName(value: string): boolean {
  const name = value.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return /(?:^|[_.\-])(?:token|key|secret|password|passwd|pwd|sig|signature|auth|authorization|credentials?|apikey|accesskey|clientsecret|code|verifier|csrf|ticket|sessionkey|accountkey)(?:$|[_.\-])/.test(name);
}

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    // URL userinfo can retain a literal percent sign beside valid escapes. Decode the valid parts too.
    return new URLSearchParams(`value=${text.replaceAll("&", "%26").replaceAll("+", "%2B")}`).get("value") ?? text;
  }
};

/** Locate userinfo after WHATWG input normalization, including invalid hosts and ports. */
function userInfoRange(value: string): { start: number; end: number } | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  const special = !scheme || /^(?:https?|ftp|wss?)$/i.test(scheme[1] ?? "");
  if (!scheme && !/^[\\/]{2}/.test(value)) return;
  let start = scheme?.[0].length ?? 0;
  if (special) {
    while (/[\\/]/.test(value.charAt(start)) && start < value.length) start++;
  } else if (value.slice(start, start + 2) === "//") start += 2;
  else return;
  const rest = value.slice(start);
  const authority =
    (special || scheme?.[1]?.toLowerCase() === "file" ? /^[^/\\?#]*/ : /^[^/?#]*/).exec(rest)?.[0] ?? "";
  const separator = authority.lastIndexOf("@");
  return separator < 0 ? undefined : { start, end: start + separator };
}

/** Map a normalized offset back without dropping controls that belong to the literal credential. */
function literalOffset(value: string, normalizedOffset: number): number {
  let index = 0;
  for (let offset = 0; offset < normalizedOffset && index < value.length; index++) {
    if (!/[\t\n\r]/.test(value.charAt(index))) offset++;
  }
  return index;
}

/** Extract credentials without treating any host or path as a secret, even for a malformed endpoint. */
export function urlParts(value: string, policy?: SecretReferencePolicy): { values: string[]; textValues: string[]; userInfo: boolean } {
  const values = new Set<string>(), textValues = new Set<string>();
  const add = (text: string, query = false, secret = false): void => {
    const plain = decode(query ? text.replaceAll("+", " ") : text);
    for (const part of new Set([text, plain])) {
      if (!part) continue;
      values.add(part);
      if (secret || (query && policy && looksLikePastedKey(plain, policy))) textValues.add(part);
    }
  };
  let userInfo = false;
  const addUserInfo = (text: string): void => {
    userInfo = true;
    const colon = text.indexOf(":");
    add(text);
    const username = colon < 0 ? text : text.slice(0, colon);
    add(username, false, policy !== undefined && looksLikePastedKey(decode(username), policy));
    if (colon >= 0) add(text.slice(colon + 1), false, true);
  };
  const literal = trimUrlControls(value);
  const normalized = literal.replace(/[\t\n\r]/g, "");
  const range = userInfoRange(normalized);
  if (range) {
    const start = literalOffset(literal, range.start);
    let end = literalOffset(literal, range.end);
    while (/[\t\n\r]/.test(literal.charAt(end)) && end < literal.length) end++;
    addUserInfo(literal.slice(start, end));
    addUserInfo(normalized.slice(range.start, range.end));
  }
  try {
    const relative = /^[\\/]{2}/.test(normalized);
    const parsed = new URL(relative ? `https:${normalized}` : normalized);
    if (parsed.username || parsed.password)
      addUserInfo(`${parsed.username}${parsed.password ? `:${parsed.password}` : ""}`);
  } catch {
    // Literal extraction above also covers incomplete endpoints; validation is unchanged.
  }
  for (const text of new Set([value, normalized])) {
    const fragment = text.indexOf("#"), query = text.indexOf("?");
    const sections: string[] = [];
    if (query >= 0 && (fragment < 0 || query < fragment))
      sections.push(text.slice(query + 1, fragment < 0 ? undefined : fragment));
    if (fragment >= 0) sections.push(text.slice(fragment + 1).replace(/^\?/, ""));
    for (const section of sections) for (const parameter of section.split("&")) {
      const equal = parameter.indexOf("=");
      if (equal >= 0) add(parameter.slice(equal + 1), true, credentialName(decode(parameter.slice(0, equal))));
      else if (policy && looksLikePastedKey(decode(parameter), policy)) add(parameter, true, true);
    }
  }
  return { values: [...values], textValues: [...textValues], userInfo };
}

/** Views conceal every query/fragment value; archive callers supply a URI-safe ASCII placeholder. */
export function maskUrlCredentials(value: string, mask = MASK): string {
  const normalized = trimUrlControls(value).replace(/[\t\n\r]/g, "");
  const range = userInfoRange(normalized);
  if (range) value = `${normalized.slice(0, range.start)}${mask}@${normalized.slice(range.end + 1)}`;
  const fragment = value.indexOf("#");
  const suffix = fragment < 0 ? undefined : value.slice(fragment + 1);
  let base = fragment < 0 ? value : value.slice(0, fragment);
  const maskParameters = (text: string): string => text.split("&").map(parameter => {
    const equal = parameter.indexOf("=");
    return equal < 0 ? parameter : `${parameter.slice(0, equal + 1)}${mask}`;
  }).join("&");
  const query = base.indexOf("?");
  if (query >= 0) base = `${base.slice(0, query + 1)}${maskParameters(base.slice(query + 1))}`;
  if (suffix === undefined) return base;
  const hidden = suffix.split("&").map(parameter => {
    const equal = parameter.indexOf("=");
    return equal < 0 ? (parameter ? mask : "") : `${parameter.slice(0, equal + 1)}${mask}`;
  }).join("&");
  return `${base}#${hidden}`;
}
