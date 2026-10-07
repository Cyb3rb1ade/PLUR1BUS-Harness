import type { Clock } from "./clock.ts";
import type { BreakGlassNotice } from "./rbac-bridge.ts";

export interface Notice {
  kind: "break-glass.granted"; grantId: string; holderUserId: string; reason: string; at: number; expiresAt: number;
}

/** What the affected user can read about a break-glass grant over their own cards (ADR-007 §Privacy, M3 acceptance 4).
 *  Delivery to the user's channels (push, mail, chat) is a hook on the server (`notifyBreakGlass`) and a follow-up; this
 *  inbox is the pull side that exists without it: per user, newest first, bounded, in memory. */
export class NoticeInbox {
  readonly #clock: Clock; readonly #max: number; readonly #maxUsers: number;
  readonly #byUser = new Map<string, Notice[]>();
  constructor(clock: Clock, maxPerUser = 50, maxUsers = 1000) { this.#clock = clock; this.#max = maxPerUser; this.#maxUsers = maxUsers; }

  add(n: BreakGlassNotice): void {
    const list = this.#byUser.get(n.userId) ?? [];
    list.unshift({ kind: "break-glass.granted", grantId: n.grantId, holderUserId: n.holderUserId, reason: n.reason, at: this.#clock.now(), expiresAt: n.expiresAt });
    if (list.length > this.#max) list.length = this.#max;
    this.#byUser.delete(n.userId); this.#byUser.set(n.userId, list);
    while (this.#byUser.size > this.#maxUsers) { const first = this.#byUser.keys().next(); if (first.done) break; this.#byUser.delete(first.value); }
  }

  list(userId: string): Notice[] { return [...(this.#byUser.get(userId) ?? [])]; }
}
