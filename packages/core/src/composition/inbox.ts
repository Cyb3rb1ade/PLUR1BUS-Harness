// Inbox composition: opens the store, wires the service to the change events and the metric, and copies the legacy
// break-glass notices over once. Producers get a late-bound port, so they can be handed out before the store is open.
import path from "node:path";
import { InboxStore, createInboxService, migrateBreakglassNotices, type InboxChange, type InboxKind, type InboxPort, type InboxService, type InboxNotice, type SettleTarget } from "../inbox/index.ts";
import type { BreakGlassNotice } from "../rbac/break-glass.ts";

export interface InboxCompositionOptions {
  stateDir: string; clock: () => number;
  admins: () => readonly string[];
  /** Retention: defaults 90 days / 1000 entries per person. */
  retention?: { maxAgeDays?: number; maxEntries?: number };
  legacyNotices: () => readonly BreakGlassNotice[];
  onChange: (c: InboxChange) => void;
  onPublished: (kind: InboxKind) => void;
  log: (message: string, fields: Record<string, unknown>) => void;
}
export interface InboxComposition { service: InboxService; store: InboxStore; migrated: number; close(): void }

export function openInbox(o: InboxCompositionOptions): InboxComposition {
  const store = new InboxStore({
    path: path.join(o.stateDir, "inbox.sqlite"), clock: o.clock,
    ...(o.retention?.maxAgeDays !== undefined ? { maxAgeMs: o.retention.maxAgeDays * 86_400_000 } : {}),
    ...(o.retention?.maxEntries !== undefined ? { maxEntries: o.retention.maxEntries } : {}),
  });
  const service = createInboxService({ store, admins: o.admins, onChange: o.onChange, onPublished: o.onPublished, log: o.log });
  let migrated = 0;
  const errText = (e: unknown) => e instanceof Error ? e.message : String(e);
  try {
    // One notice at a time: a malformed one is logged and skipped, it must not hide the valid notices behind it.
    for (const n of o.legacyNotices()) {
      try { migrated += migrateBreakglassNotices(store, [n]); } catch (e) { o.log("a break-glass notice was not copied to the inbox", { error: errText(e) }); }
    }
  } catch (e) { o.log("break-glass notices were not copied to the inbox", { error: errText(e) }); }
  return { service, store, migrated, close: () => store.close() };
}

/** A port that can be handed to producers before the inbox is open (and after it closed): calls in between are dropped. */
export function lateInboxPort(get: () => InboxService | null): InboxPort {
  return { publish: (n: InboxNotice, options?: { cooldownMs: number }) => get()?.publish(n, options), settle: (t: SettleTarget, k: string) => get()?.settle(t, k) };
}
