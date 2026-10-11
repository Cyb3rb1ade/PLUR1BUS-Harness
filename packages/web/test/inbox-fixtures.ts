// Inbox entries and an in-memory `inbox.*` for the mock RPC: paging by cursor, filters, mark read, dismiss and the counts that
// inbox.count derives from them. The store is handed back so a test can change it behind the page's back.
import type { MockRpc, MockRpcCtx } from "./mock-rpc.ts";
import { rpcError } from "./mock-rpc.ts";
import type { InboxEntry, InboxKind } from "../src/pages/inbox/rpc-types.ts";
import { INBOX_KINDS } from "../src/pages/inbox/rpc-types.ts";

const BASE = Date.UTC(2026, 9, 10, 9, 0, 0);

export function entry(over: Partial<InboxEntry> & { id: string; kind: InboxKind }): InboxEntry {
  return { severity: "warning", titleKey: "inbox.approval.requested", params: {}, ref: null, createdAt: BASE, readAt: null, dismissedAt: null, ...over };
}

/** One entry of each kind that the core produces, newest first. e2 is already read. */
export function sampleEntries(): InboxEntry[] {
  return [
    entry({ id: "e1", kind: "approval", titleKey: "inbox.approval.requested", params: { capability: "shell" }, ref: { route: "/approvals", objectId: "apr_1" }, createdAt: BASE + 6000 }),
    entry({ id: "e2", kind: "job-failed", titleKey: "inbox.jobFailed", params: { job: "nightly-dreams" }, ref: { route: "/recurring", objectId: "run_9" }, createdAt: BASE + 5000, readAt: BASE + 5500 }),
    entry({ id: "e3", kind: "media-index", titleKey: "inbox.mediaIndex.failed", params: { stage: "embed" }, ref: { route: "/library", objectId: "med_3" }, createdAt: BASE + 4000 }),
    entry({ id: "e4", kind: "pairing", titleKey: "inbox.pairing.requested", params: { channel: "telegram" }, ref: { route: "/settings", objectId: "pair_4" }, createdAt: BASE + 3000 }),
    entry({ id: "e5", kind: "channel", titleKey: "inbox.channel.misconfigured", params: { channel: "matrix" }, ref: { route: "/switchboard", objectId: "matrix" }, createdAt: BASE + 2000 }),
    entry({ id: "e6", kind: "breakglass", severity: "critical", titleKey: "inbox.breakglass.granted", params: { holderUserId: "usr_admin", expiresAt: BASE + 3_600_000 }, ref: { route: "/inbox", objectId: "bg_1" }, createdAt: BASE + 1000 }),
  ];
}

export type InboxStore = {
  entries: InboxEntry[];
  /** When set, a request with a cursor fails with E_INBOX_CURSOR (the cursor went stale). */
  staleCursor: boolean;
};

type ListParams = { kinds?: InboxKind[]; unreadOnly?: boolean; limit?: number; cursor?: string };

function counts(entries: readonly InboxEntry[]): { unread: Record<InboxKind, number>; total: number } {
  const unread = Object.fromEntries(INBOX_KINDS.map((k) => [k, 0])) as Record<InboxKind, number>;
  const visible = entries.filter((e) => e.dismissedAt === null);
  for (const e of visible) if (e.readAt === null) unread[e.kind]++;
  return { unread, total: visible.length };
}

/** Installs inbox.list, inbox.count, inbox.markRead and inbox.dismiss on the mock. Call before the page signs in. */
export function installInbox(rpc: MockRpc, initial: readonly InboxEntry[], opts: { pageSize?: number } = {}): InboxStore {
  const store: InboxStore = { entries: initial.map((e) => ({ ...e })), staleCursor: false };
  const pageSize = opts.pageSize ?? 50;

  rpc.handle("inbox.count", () => counts(store.entries), { write: false });

  rpc.handle("inbox.list", (params: unknown) => {
    const p = (params ?? {}) as ListParams;
    if (p.cursor !== undefined && store.staleCursor) throw rpcError("E_INBOX_CURSOR", "the cursor is no longer valid");
    const kinds = p.kinds ?? [];
    const visible = store.entries
      .filter((e) => e.dismissedAt === null)
      .filter((e) => kinds.length === 0 || kinds.includes(e.kind))
      .filter((e) => !p.unreadOnly || e.readAt === null)
      .sort((a, b) => b.createdAt - a.createdAt);
    const offset = p.cursor ? Number(p.cursor.slice(2)) : 0;
    const limit = Math.min(p.limit ?? pageSize, pageSize);
    const page = visible.slice(offset, offset + limit);
    return { entries: page, nextCursor: offset + limit < visible.length ? `o:${offset + limit}` : null };
  }, { write: false });

  rpc.handle("inbox.markRead", (params: unknown, _ctx: MockRpcCtx) => {
    const p = params as { ids?: string[]; all?: boolean };
    const now = Date.now();
    let changed = 0;
    for (const e of store.entries) {
      const hit = p.all === true ? e.dismissedAt === null : (p.ids ?? []).includes(e.id);
      if (hit && e.readAt === null) { e.readAt = now; changed++; }
    }
    return { changed };
  });

  rpc.handle("inbox.dismiss", (params: unknown) => {
    const ids = (params as { ids: string[] }).ids;
    let changed = 0;
    for (const e of store.entries) if (ids.includes(e.id) && e.dismissedAt === null) { e.dismissedAt = Date.now(); changed++; }
    return { changed };
  });

  return store;
}

/** The unread total the badge must show for a store. */
export function unreadTotal(store: InboxStore): number {
  return Object.values(counts(store.entries).unread).reduce((a, b) => a + b, 0);
}
