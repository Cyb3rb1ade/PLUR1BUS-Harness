import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import { InboxError, type InboxChange, type InboxKind, type InboxService } from "../inbox/index.ts";
import type { Handler, NotifyOptions } from "./server.ts";
import { RpcError } from "./errors.ts";

/** The caller's own inbox is the only inbox there is: no handler takes a user, so no role can name another person's. */
function self(p: Principal): string {
  if (p.kind !== "person" || typeof p.userId !== "string" || p.userId === "") throw new RpcError("E_DENIED", "a person is required");
  return p.userId;
}
function failure(e: unknown): never {
  if (e instanceof RpcError) throw e;
  if (e instanceof InboxError) {
    if (e.code === "cursor") throw new RpcError("E_INBOX_CURSOR", e.message, { reason: "inbox-cursor" });
    throw new RpcError("E_INVALID_PARAMS", e.message, { reason: "inbox-invalid" });
  }
  throw new RpcError("E_STORAGE", "inbox storage unavailable");
}

export function buildInboxSurface(service: () => InboxService | null): Record<string, Handler> {
  const bind = (fn: (s: InboxService, userId: string, p: any) => unknown): Handler => async (p, ctx) => {
    const a = authenticatedPrincipal(ctx), s = service();
    if (!s) throw new RpcError("E_NOT_AVAILABLE", "inbox unavailable");
    try { return fn(s, self(a), p ?? {}); } catch (e) { return failure(e); }
  };
  return {
    "inbox.list": bind((s, u, p) => { const r = s.list(u, p); return { entries: r.entries, nextCursor: r.nextCursor ?? null }; }),
    "inbox.count": bind((s, u) => s.count(u)),
    "inbox.markRead": bind((s, u, p) => {
      const hasIds = p.ids !== undefined, hasAll = p.all !== undefined;
      if (hasIds === hasAll || (hasAll && p.all !== true)) throw new RpcError("E_INVALID_PARAMS", "pass either ids or all: true", { reason: "inbox-invalid" });
      return { changed: s.markRead(u, hasAll ? "all" : p.ids) };
    }),
    "inbox.dismiss": bind((s, u, p) => ({ changed: s.dismiss(u, p.ids) })),
  };
}

/** `inbox.changed` carries no entry data. The server cannot address one connection, so the rule applies to the whole audience:
 *  unless every subscriber that named the event is the person it belongs to, it is withheld from all of them (fail closed).
 *  Clients refresh with inbox.count on connect, so a withheld event is a delay, never a loss. */
export async function deliverInboxChange(change: InboxChange, d: {
  subscriptions: () => readonly { connectionId: string; names?: readonly string[] | undefined }[];
  principalOf: (connectionId: string) => Promise<Principal | null | undefined>;
  notify: (method: string, params: object, options: NotifyOptions) => void;
}): Promise<void> {
  const connections = [...new Set(d.subscriptions().filter(s => s.names?.includes("inbox.changed")).map(s => s.connectionId))];
  if (!connections.length) return;
  for (const id of connections) {
    let p: Principal | null | undefined;
    try { p = await d.principalOf(id); } catch { return; }
    if (!p || p.kind !== "person" || p.userId !== change.userId) return;
  }
  d.notify("inbox.changed", { change: change.change, kinds: change.kinds as InboxKind[] }, { optIn: true });
}
