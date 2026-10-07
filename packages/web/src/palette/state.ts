// Open state of the palette. Signal-only (no component imports), so the sidebar's search pill and the hotkey can use it without cycles.
import { signal } from "@preact/signals";

export const paletteOpen = signal(false);
export const openPalette = (): void => { paletteOpen.value = true; };
export const closePalette = (): void => { paletteOpen.value = false; };
export const togglePalette = (): void => { paletteOpen.value = !paletteOpen.value; };
