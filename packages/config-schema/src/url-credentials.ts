// Browser-safe endpoint policy: keep public host/path material and conceal credential components.
const MASK = "••••";

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
export function urlParts(value: string): { values: string[]; userInfo: boolean } {
  const values = new Set<string>();
  const add = (text: string, query = false): void => {
    if (text !== "") values.add(text);
    const plain = decode(query ? text.replaceAll("+", " ") : text);
    if (plain !== "") values.add(plain);
  };
  let userInfo = false;
  const addUserInfo = (text: string): void => {
    userInfo = true;
    const colon = text.indexOf(":");
    add(text);
    add(colon < 0 ? text : text.slice(0, colon));
    if (colon >= 0) add(text.slice(colon + 1));
  };
  const literal = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
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
    const fragment = text.indexOf("#");
    const query = text.indexOf("?");
    if (query >= 0 && (fragment < 0 || query < fragment)) {
      for (const parameter of text.slice(query + 1, fragment < 0 ? undefined : fragment).split("&")) {
        const equal = parameter.indexOf("=");
        if (equal >= 0) add(parameter.slice(equal + 1), true);
      }
    }
  }
  return { values: [...values], userInfo };
}

/** Schema-classified endpoints keep their host/path and conceal userinfo and every query value. */
export function maskUrlCredentials(value: string): string {
  const normalized = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
  const range = userInfoRange(normalized);
  if (range) value = `${normalized.slice(0, range.start)}${MASK}@${normalized.slice(range.end + 1)}`;
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  if (query < 0 || (fragment >= 0 && fragment < query)) return value;
  const parameters = value
    .slice(query + 1, fragment < 0 ? undefined : fragment)
    .split("&")
    .map((parameter) => {
      const equal = parameter.indexOf("=");
      return equal < 0 ? parameter : `${parameter.slice(0, equal + 1)}${MASK}`;
    });
  return `${value.slice(0, query + 1)}${parameters.join("&")}${fragment < 0 ? "" : value.slice(fragment)}`;
}
