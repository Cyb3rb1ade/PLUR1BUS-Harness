// The InboxPort producers write to, and the person-facing operations the RPC surface calls. Every producer call is
// best-effort: an inbox failure is logged and never reaches the source module (no behaviour change in the sources).
import { INBOX_KINDS, InboxStore, type InboxCounts, type InboxDraft, type InboxEntry, type InboxKind, type InboxListQuery } from "./store.ts";

export type InboxTarget = { userId: string } | { audience: "admins" };
export type InboxNotice = Omit<InboxDraft, "userId"> & InboxTarget;
/** `settle` may also close an entry for everyone who has it, when the producer does not know whose it was. */
export type SettleTarget = InboxTarget | { audience: "all" };
export interface InboxChange { userId: string; change: "created" | "read" | "dismissed" | "settled"; kinds: InboxKind[] }

/** What a source module is given: one call to publish, one to close the entry again. Both are synchronous and never throw. */
export interface InboxPort {
  publish(n: InboxNotice): void;
  settle(target: SettleTarget, dedupeKey: string): void;
}
export interface InboxService extends InboxPort {
  list(userId: string, q: InboxListQuery): { entries: InboxEntry[]; nextCursor?: string };
  count(userId: string): InboxCounts;
  markRead(userId: string, ids: readonly string[] | "all"): number;
  dismiss(userId: string, ids: readonly string[]): number;
}
export interface InboxServiceOptions {
  store: InboxStore;
  /** Owners and admins at the time of the call: the recipients of installation-wide kinds (channel, job-failed, media-index, update, system). */
  admins: () => readonly string[];
  /** After the write committed. A throwing listener never undoes it. */
  onChange?: (c: InboxChange) => void;
  /** One tick per created entry; the kind is the only label. */
  onPublished?: (kind: InboxKind) => void;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export function createInboxService(o: InboxServiceOptions): InboxService {
  const log = o.log ?? (() => {});
  const emit = (c: InboxChange): void => { try { o.onChange?.(c); } catch (e) { log("inbox change listener failed", { error: e instanceof Error ? e.message : String(e) }); } };
  const users = (t: InboxTarget): string[] => "userId" in t ? [t.userId] : [...new Set(o.admins())];
  return {
    publish(n) {
      try {
        for (const userId of users(n)) {
          const { audience: _a, userId: _u, ...rest } = n as InboxNotice & { audience?: string; userId?: string };
          const r = o.store.publish({ ...rest, userId });
          if (!r.created) continue;
          try { o.onPublished?.(n.kind); } catch { /* a metric never blocks */ }
          emit({ userId, change: "created", kinds: [n.kind] });
        }
      } catch (e) { log("inbox publish failed", { kind: n.kind, error: e instanceof Error ? e.message : String(e) }); }
    },
    settle(target, dedupeKey) {
      try {
        const kind = dedupeKey.split(":")[0] as InboxKind;
        const kinds = INBOX_KINDS.includes(kind) ? [kind] : [];
        const closed = "audience" in target && target.audience === "all" ? o.store.settleEverywhere(dedupeKey) : users(target as InboxTarget).filter(userId => o.store.settle(userId, dedupeKey));
        for (const userId of new Set(closed)) emit({ userId, change: "settled", kinds });
      } catch (e) { log("inbox settle failed", { error: e instanceof Error ? e.message : String(e) }); }
    },
    list: (userId, q) => o.store.list(userId, q),
    count: userId => o.store.count(userId),
    markRead(userId, ids) {
      const kinds = o.store.kindsOf(userId, ids, "unread"), changed = o.store.markRead(userId, ids);
      if (changed > 0) emit({ userId, change: "read", kinds });
      return changed;
    },
    dismiss(userId, ids) {
      const kinds = o.store.kindsOf(userId, ids, "open");
      const changed = o.store.dismiss(userId, ids);
      if (changed > 0) emit({ userId, change: "dismissed", kinds });
      return changed;
    },
  };
}
