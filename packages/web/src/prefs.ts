// Per-viewer conveniences (theme, language). localStorage can be blocked or throw (private windows, blocked site data),
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
