// Global keys for the palette: ⌘K on macOS, Ctrl+K elsewhere (toggles), and "/" (opens, but not while typing in a field).
// Only while signed in and on a page; the sign-in page has no palette.
import { route } from "../router.ts";
import { sessionState } from "../session.ts";
import { paletteOpen, togglePalette, openPalette } from "./state.ts";

export function isMac(): boolean {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  return /mac|iphone|ipad/i.test(nav?.userAgentData?.platform ?? nav?.platform ?? "");
}

/** The shortcut for `aria-keyshortcuts` and hints. */
export const shortcut = (): string => (isMac() ? "Meta+K" : "Control+K");

function editable(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  return el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName) || el.getAttribute("role") === "combobox";
}

export function onPaletteKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  if (sessionState.value.status !== "authenticated" || route.value.kind !== "page") return;
  if (e.key.toLowerCase() === "k" && !e.altKey && !e.shiftKey && (isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    togglePalette();
  } else if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !paletteOpen.value && !editable(e.target)) {
    e.preventDefault();
    openPalette();
  }
}

/** Installs the hotkeys on the document; returns the disposer. */
export function bindPalette(): () => void {
  document.addEventListener("keydown", onPaletteKey);
  return () => document.removeEventListener("keydown", onPaletteKey);
}
