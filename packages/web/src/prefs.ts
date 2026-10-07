// Per-viewer conveniences (theme, language); the theme also lives in a cookie (theme.ts). localStorage can be blocked or throw (private windows, blocked site data),
// so every access is guarded and an in-memory map keeps the page working.
const PREFIX = "plur1bus.web.";
const memory = new Map<string, string>();

export function getPref(key: string): string | null {
  try {
    const v = globalThis.localStorage?.getItem(PREFIX + key);
    if (v !== null && v !== undefined) return v;
  } catch { /* storage unavailable: fall through to memory */ }
  return memory.get(key) ?? null;
}

export function setPref(key: string, value: string): void {
  memory.set(key, value);
  try { globalThis.localStorage?.setItem(PREFIX + key, value); } catch { /* memory copy is enough */ }
}

/** Value of cookie `name` in a `document.cookie` string, or null. */
export function readCookie(cookie: string, name: string): string | null {
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Assign one cookie string; blocked cookies are not an error (the in-memory value still works). */
export function writeCookie(cookie: string): void {
  try { if (globalThis.document) globalThis.document.cookie = cookie; } catch { /* cookies unavailable */ }
}
