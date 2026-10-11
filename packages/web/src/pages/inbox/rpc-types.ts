// Inbox RPC (docs/inbox.md, docs/rpc.md): the caller's own entries only. Reads are `{ write: false }`; the writes take the
// usual one-time CSRF token.
export const INBOX_KINDS = ["breakglass", "approval", "job-failed", "update", "media-index", "pairing", "channel", "system"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export type InboxSeverity = "info" | "warning" | "critical";
export type InboxParamValue = string | number | boolean;

export type InboxEntry = {
  id: string;
  kind: InboxKind;
  severity: InboxSeverity;
  /** i18n key from the core. The client translates it; a key this UI does not know falls back to the kind label. */
  titleKey: string;
  params: Record<string, InboxParamValue>;
  /** Where to go: an app route and an object id, both optional. */
  ref: { route?: string; objectId?: string } | null;
  createdAt: number;
  readAt: number | null;
  dismissedAt: number | null;
};

export type InboxListResult = { entries: InboxEntry[]; nextCursor: string | null };
export type InboxCountResult = { unread: Record<InboxKind, number>; total: number };
export type InboxListParams = { kinds?: InboxKind[]; unreadOnly?: boolean; includeDismissed?: boolean; limit?: number; cursor?: string };

declare module "../../api/index.ts" {
  interface RpcMethods {
    "inbox.list": { params: InboxListParams | undefined; result: InboxListResult };
    "inbox.count": { params: Record<string, never>; result: InboxCountResult };
    "inbox.markRead": { params: { ids: string[] } | { all: true }; result: { changed: number } };
    "inbox.dismiss": { params: { ids: string[] }; result: { changed: number } };
  }
}
