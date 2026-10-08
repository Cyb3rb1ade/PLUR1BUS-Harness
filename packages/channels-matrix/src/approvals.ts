import { randomBytes } from "node:crypto";
import type { ApprovalChoice } from "./port.ts";

export const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
export const MAX_APPROVAL_TTL_MS = 24 * 60 * 60_000;
export const MAX_PENDING_APPROVALS = 256;
const MAX_CHOICES = 9;

/** Shape checks shared by prompt() (before anything is sent) and register(). */
export function validatePrompt(choices: readonly ApprovalChoice[], approverIds: readonly string[], ttlMs?: number): void {
  if (choices.length < 1 || choices.length > MAX_CHOICES) throw new RangeError("1..9 choices required");
  if (new Set(choices.map((c) => c.id)).size !== choices.length) throw new RangeError("duplicate choice ids");
  if (approverIds.length === 0) throw new RangeError("at least one approver is required");
  const ttl = ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > MAX_APPROVAL_TTL_MS) throw new RangeError("ttlMs must be 1 s .. 24 h");
}

/** Keycap emoji for the Nth choice; `deny` is always the cross mark. */
export function choiceEmoji(index: number, id: string): string {
  if (id === "deny") return "❌";
  return `${index + 1}️⃣`;
}

/** Variation selectors vary between clients; compare keys without them. */
export const normalizeKey = (k: string): string => k.replace(/️/g, "");

interface Pending {
  promptId: string;
  chatId: string;
  roomId: string;
  eventId: string;
  approvers: ReadonlySet<string>;
  keys: Map<string, string>;
  expiresAt: number;
  used: boolean;
}

export type ClaimResult =
  | { status: "ok"; promptId: string; chatId: string; choiceId: string }
  | { status: "unauthorized" }
  | { status: "expired" }
  | { status: "replayed" }
  | { status: "ignored" };

export interface RegisteredPrompt {
  promptId: string;
  /** Emoji in choice order, to pre-seed as reactions. */
  reactions: { emoji: string; choiceId: string }[];
}

/**
 * Pending reaction-approvals. Bound to the prompt event, the room and the approver set. Single-use and TTL'd. Nothing here
 * grants anything: a successful claim only yields a decision for the host to act on.
 */
export class ReactionApprovals {
  readonly #byEvent = new Map<string, Pending>();
  readonly #now: () => number;
  constructor(now: () => number) {
    this.#now = now;
  }

  get size(): number {
    return this.#byEvent.size;
  }

  /** Registers a prompt once its event id is known. Returns the emoji plan for the pre-seeded reactions. */
  register(input: {
    chatId: string;
    roomId: string;
    eventId: string;
    choices: readonly ApprovalChoice[];
    approverIds: readonly string[];
    ttlMs?: number;
  }): RegisteredPrompt {
    validatePrompt(input.choices, input.approverIds, input.ttlMs);
    const ttl = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.#prune();
    if (this.#byEvent.size >= MAX_PENDING_APPROVALS) throw new Error("too many pending approvals");
    const keys = new Map<string, string>();
    const reactions = input.choices.map((c, i) => {
      const emoji = choiceEmoji(i, c.id);
      keys.set(normalizeKey(emoji), c.id);
      return { emoji, choiceId: c.id };
    });
    const promptId = randomBytes(16).toString("base64url");
    this.#byEvent.set(input.eventId, {
      promptId,
      chatId: input.chatId,
      roomId: input.roomId,
      eventId: input.eventId,
      approvers: new Set(input.approverIds),
      keys,
      expiresAt: this.#now() + ttl,
      used: false,
    });
    return { promptId, reactions };
  }

  /** Checks one reaction. Order: unknown prompt and wrong room are silent; unauthorized comes before expiry and replay. */
  claim(input: { roomId: string; eventId: string; key: string; sender: string }): ClaimResult {
    const p = this.#byEvent.get(input.eventId);
    if (!p || p.roomId !== input.roomId) return { status: "ignored" };
    if (!p.approvers.has(input.sender)) return { status: "unauthorized" };
    if (this.#now() >= p.expiresAt) {
      this.#byEvent.delete(input.eventId);
      return { status: "expired" };
    }
    if (p.used) return { status: "replayed" };
    const choiceId = p.keys.get(normalizeKey(input.key));
    if (choiceId === undefined) return { status: "ignored" };
    p.used = true;
    return { status: "ok", promptId: p.promptId, chatId: p.chatId, choiceId };
  }

  /** Drops a prompt (e.g. when its pre-seed failed), so it cannot be activated. */
  cancel(eventId: string): void {
    this.#byEvent.delete(eventId);
  }

  clear(): void {
    this.#byEvent.clear();
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, p] of this.#byEvent) if (p.expiresAt <= now) this.#byEvent.delete(id);
  }
}
