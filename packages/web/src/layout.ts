import { signal } from "@preact/signals";

/** Compact layout (< 1024 CSS px, desktop spec §13.7 rule 3). Mirrors the CSS breakpoint; JS needs it only for the
 * header "More" menu and for closing the overlay when the window grows. */
export const COMPACT_QUERY = "(max-width: 1023.98px)";
const mq = globalThis.matchMedia?.(COMPACT_QUERY);
export const compact = signal<boolean>(mq?.matches ?? false);
mq?.addEventListener("change", (e) => { compact.value = e.matches; });
