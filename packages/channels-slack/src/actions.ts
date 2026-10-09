import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface ActionEntry {
  /** Approval choice id or generic button data. */
  data: string;
  /** Only this Slack user may activate this entry (generic buttons). */
  senderId?: string;
}
export interface ActionGroup<T> {
  readonly id: string;
  readonly chatId: string;
  readonly approvers: ReadonlySet<string> | undefined;
  readonly expires: number;
  readonly meta: T;
}
export type Activation<T> =
  | { status: "ok"; group: ActionGroup<T>; entry: ActionEntry }
  | { status: "forbidden"; group: ActionGroup<T> }
  | { status: "invalid" };

interface Stored<T> {
  group: ActionGroup<T>;
  handles: Map<string, ActionEntry>;
}

/** Opaque, signed, single-use handles for Block Kit `action_id`s. A handle carries no data and no identity: it is a random
 *  id plus a MAC. Activating any handle of a group consumes the whole group (one decision per prompt). A wrong user does
 *  not consume anything, so the legitimate approver can still decide. */
export class ActionRegistry<T> {
  readonly #key: string;
  readonly #now: () => number;
  readonly #groups = new Map<string, Stored<T>>();
  readonly #byHandle = new Map<string, string>();
  constructor(key: string, now: () => number = Date.now) {
    this.#key = key;
    this.#now = now;
  }
  issue(input: {
    chatId: string;
    approvers?: readonly string[];
    ttlMs: number;
    entries: readonly ActionEntry[];
    meta: T;
  }): { id: string; handles: string[] } {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 86_400_000)
      throw new RangeError("action TTL must be 1 ms..24 h");
    this.#prune();
    if (this.#groups.size >= 1000) throw new Error("too many pending actions");
    const id = randomBytes(12).toString("base64url");
    const handles = new Map<string, ActionEntry>();
    const wires = input.entries.map((e) => {
      const h = randomBytes(12).toString("base64url");
      handles.set(h, e);
      this.#byHandle.set(h, id);
      return `${h}.${this.#mac(h)}`;
    });
    this.#groups.set(id, {
      group: {
        id,
        chatId: input.chatId,
        approvers: input.approvers ? new Set(input.approvers) : undefined,
        expires: this.#now() + input.ttlMs,
        meta: input.meta,
      },
      handles,
    });
    return { id, handles: wires };
  }
  activate(wire: string, chatId: string, senderId: string): Activation<T> {
    if (!/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/.test(wire)) return { status: "invalid" };
    const [h, mac] = wire.split(".") as [string, string];
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(this.#mac(h)))) return { status: "invalid" };
    const gid = this.#byHandle.get(h);
    const stored = gid ? this.#groups.get(gid) : undefined;
    const entry = stored?.handles.get(h);
    if (!stored || !entry || stored.group.expires <= this.#now() || stored.group.chatId !== chatId) return { status: "invalid" };
    if ((stored.group.approvers && !stored.group.approvers.has(senderId)) || (entry.senderId !== undefined && entry.senderId !== senderId))
      return { status: "forbidden", group: stored.group };
    this.#drop(stored);
    return { status: "ok", group: stored.group, entry };
  }
  /** Removes a group whose message could not be posted. */
  revoke(id: string): void {
    const s = this.#groups.get(id);
    if (s) this.#drop(s);
  }
  clear(): void {
    this.#groups.clear();
    this.#byHandle.clear();
  }
  #drop(s: Stored<T>): void {
    for (const h of s.handles.keys()) this.#byHandle.delete(h);
    this.#groups.delete(s.group.id);
  }
  #prune(): void {
    for (const s of [...this.#groups.values()]) if (s.group.expires <= this.#now()) this.#drop(s);
  }
  #mac(h: string): string {
    return createHmac("sha256", this.#key).update(h).digest("base64url").slice(0, 22);
  }
}
