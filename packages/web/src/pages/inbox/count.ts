// The unread count behind the sidebar badge. It lives in the start-up bundle on purpose: the sidebar is always there, the inbox
// page is not. Only `inbox.count` is ever used as the data source. `inbox.changed` is a hint to ask again, and it carries no entry
// data; the sidebar itself opens no event stream (the inbox page does, while it is open: pages/inbox/page.ts).
import { signal } from "@preact/signals";
import { getApi } from "../../api/shared.ts";
import type { SseEvent } from "../../api/sse.ts";
import { sessionState } from "../../session.ts";

/** Unread entries over all kinds; null while unknown (not signed in, the call failed, or the core has no inbox yet). */
export const inboxUnread = signal<number | null>(null);

export async function refreshInboxCount(): Promise<void> {
  if (sessionState.value.status !== "authenticated") { inboxUnread.value = null; return; }
  try {
    const c = await getApi().rpc("inbox.count", {}, { write: false });
    inboxUnread.value = Object.values(c.unread).reduce((sum, n) => sum + n, 0);
  } catch {
    // The badge is a hint: a failed count shows no badge rather than a wrong one.
    inboxUnread.value = null;
  }
}

/** Keeps the badge current while signed in: once on start, when the window is back online, and on every route change.
 *  Returns the stop function. */
export function watchInboxCount(): () => void {
  const again = (): void => { void refreshInboxCount(); };
  void refreshInboxCount();
  window.addEventListener("online", again);
  window.addEventListener("hashchange", again);
  return () => {
    window.removeEventListener("online", again);
    window.removeEventListener("hashchange", again);
  };
}

/** Whether an /events message is the inbox hint (named event, or a JSON-RPC notification object in the data). */
export function isInboxChanged(e: SseEvent): boolean {
  if (e.event === "inbox.changed") return true;
  try { return (JSON.parse(e.data) as { method?: unknown }).method === "inbox.changed"; } catch { return false; }
}
