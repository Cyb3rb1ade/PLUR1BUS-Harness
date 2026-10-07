// D109 §5: approval.requested | approval.resolved | grant.changed on the RPC event path.
//
// Who may receive them: only a connection whose principal is a person, is the person the request / grant belongs to, and holds
// approval.read (grant.read for grant.changed); and only a connection that opted in by naming the notification in `events.subscribe`.
// The RPC server delivers a notification to every matching subscription and cannot address one connection, so the rule is applied to
// the whole audience: if ANY opted-in connection fails it, the notification is withheld from all of them (fail closed; a withheld one is
// logged). An agent that subscribes to approval.requested therefore silences the notification instead of reading it.
// (A per-connection address in module-api's NotifyOptions would make this selective; see the report.)
//
// The nonce never gets here: the service's events carry it for channel relays, this module forwards the wire record only.
import type { ApprovalRecord, GrantRecord } from "@plur1bus/rpc-schema";
import type { GrantState, StoredGrant } from "../grants/store.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";
import type { ApprovalEvent, ApprovalEvents } from "./service.ts";
import { approvalRecordOf, grantRecordOf } from "./wire.ts";

export interface PermissionNotifierOptions {
  /** The RPC server's live subscriptions. */
  subscriptions: () => readonly { connectionId: string; names?: readonly string[] | undefined }[];
  notify: (method: string, params: object, opts: { optIn: true }) => void;
  /** Who a connection is, by the same resolver the RBAC guard uses. */
  principalOf: (connectionId: string, method: string) => Promise<Principal | null | undefined>;
  grantRecordOf: (grantId: string, person: string) => { grant: StoredGrant; state: GrantState } | undefined;
  now: () => number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export interface PermissionNotifier {
  /** Hand this to `createApprovalService({ events })`. */
  readonly events: ApprovalEvents;
  /** For grants the RPC handlers create or revoke (the service announces the ones a decision creates). */
  grantChanged(change: "created" | "revoked", grant: GrantRecord): void;
  /** Resolves when everything queued so far has been delivered or withheld. */
  idle(): Promise<void>;
  /** No delivery after this. */
  close(): void;
}

export function createPermissionNotifier(o: PermissionNotifierOptions): PermissionNotifier {
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  const log = o.log ?? (() => {});

  async function deliver(method: string, action: "approval.read" | "grant.read", person: string, params: object): Promise<void> {
    if (closed) return;
    const connections = [...new Set(o.subscriptions().filter((s) => s.names?.includes(method)).map((s) => s.connectionId))];
    if (connections.length === 0) return;
    for (const connectionId of connections) {
      let allowed = false;
      try {
        const p = await o.principalOf(connectionId, method);
        allowed = p !== null && p !== undefined && p.kind === "person" && p.userId === person
          && authorize(p, action, { kind: "system" }, { now: o.now() }).effect === "allow";
      } catch { allowed = false; }
      if (!allowed) { log("notification withheld: an opted-in connection may not receive it", { method, connectionId }); return; }
    }
    if (closed) return;
    o.notify(method, params, { optIn: true });
  }

  const enqueue = (method: string, action: "approval.read" | "grant.read", person: string, make: () => object | undefined): void => {
    if (closed) return;
    chain = chain.then(async () => {
      const params = make();
      if (params) await deliver(method, action, person, params);
    }).catch((err: unknown) => { log("notification failed", { method, err: String((err as Error)?.message ?? err) }); });
  };

  const events: ApprovalEvents = {
    emit<E extends ApprovalEvent>(name: E["name"], payload: E["payload"]): void {
      if (name === "approval.requested" || name === "approval.resolved") {
        const view = (payload as { approval: Parameters<typeof approvalRecordOf>[0] }).approval;
        const record: ApprovalRecord = approvalRecordOf(view);
        enqueue(name, "approval.read", view.principal, () => ({ approval: record }));
      } else if (name === "grant.changed") {
        const c = payload as Extract<ApprovalEvent, { name: "grant.changed" }>["payload"];
        enqueue("grant.changed", "grant.read", c.person, () => {
          const v = o.grantRecordOf(c.grantId, c.person);
          return v ? { change: c.change, grant: grantRecordOf(v.grant, v.state) } : undefined;
        });
      }
      // approval.parked is a hint for relays, not a wire notification.
    },
  };

  return {
    events,
    grantChanged(change, grant) { enqueue("grant.changed", "grant.read", grant.person, () => ({ change, grant })); },
    idle: () => chain,
    close() { closed = true; },
  };
}
