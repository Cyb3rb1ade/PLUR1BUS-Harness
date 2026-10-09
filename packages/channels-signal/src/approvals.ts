import { randomBytes } from "node:crypto";
import type { ApprovalChoice, ApprovalDecision } from "./port.ts";

// Reply-code approvals: a short random token per prompt plus the choice number. Signal has no buttons.
// Token and code must both match, the reply must come from an approver in the same chat, and each prompt decides once.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const TOKEN_LEN = 4;
const MAX_LIVE = 200;
const MAX_FAILED_PER_PROMPT = 20;
/** Used and expired prompts stay as tombstones this long, so replays and late activations are refused, not re-read as text. */
const TOMBSTONE_GRACE_MS = 24 * 3_600_000;
const ATTEMPT = /^\s*([2-9A-HJ-NP-Z]{4})\s+([0-9])\s*$/;
export const APPROVAL_DEFAULT_TTL_MS = 5 * 60_000;
export const APPROVAL_MAX_TTL_MS = 24 * 3_600_000;

interface Live {
  promptId: string;
  chatId: string;
  approverIds: readonly string[];
  codes: ReadonlyMap<string, string>;
  expires: number;
  used: boolean;
  failed: number;
}

export type ApprovalCheck =
  | { kind: "none" }
  | { kind: "refused"; reason: "expired" | "unauthorized" | "replayed" | "unknown" }
  | { kind: "decided"; decision: Omit<ApprovalDecision, "at"> };

export interface CreatedPrompt {
  promptId: string;
  token: string;
  codes: ReadonlyArray<{ code: string; choiceId: string; label: string }>;
}

/** Opaque, random, single-use, TTL'd prompt book. Pure in-memory; a restart invalidates outstanding prompts. */
export class ApprovalBook {
  readonly #now: () => number;
  readonly #live = new Map<string, Live>(); // key: chatId + NUL + token
  constructor(now: () => number) {
    this.#now = now;
  }
  create(input: {
    chatId: string;
    choices: readonly ApprovalChoice[];
    approverIds: readonly string[];
    ttlMs?: number;
  }): CreatedPrompt {
    const ttl = input.ttlMs ?? APPROVAL_DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > APPROVAL_MAX_TTL_MS) throw new RangeError("approval TTL must be 1 ms..24 h");
    if (input.choices.length < 1 || input.choices.length > 9) throw new RangeError("approval needs 1..9 choices");
    if (input.approverIds.length < 1) throw new RangeError("approval needs at least one approver");
    const ids = new Set<string>();
    const codes = new Map<string, string>();
    const listed: Array<{ code: string; choiceId: string; label: string }> = [];
    let next = 1;
    for (const c of input.choices) {
      if (!c.id || !c.label || ids.has(c.id)) throw new RangeError("approval choices need unique ids and labels");
      ids.add(c.id);
      const code = c.id === "deny" ? "0" : String(next++);
      if (code !== "0" && Number(code) > 9) throw new RangeError("too many choices");
      codes.set(code, c.id);
      listed.push({ code, choiceId: c.id, label: c.label });
    }
    this.#prune();
    if (this.#live.size >= MAX_LIVE) throw new Error("too many pending approvals");
    let token = "";
    do token = randomToken();
    while (this.#live.has(key(input.chatId, token)));
    const promptId = randomBytes(12).toString("base64url");
    this.#live.set(key(input.chatId, token), {
      promptId,
      chatId: input.chatId,
      approverIds: [...input.approverIds],
      codes,
      expires: this.#now() + ttl,
      used: false,
      failed: 0,
    });
    return { promptId, token, codes: listed };
  }
  check(chatId: string, senderIds: readonly string[], text: string): ApprovalCheck {
    const m = ATTEMPT.exec(text.toUpperCase());
    if (!m) return { kind: "none" };
    const now = this.#now();
    const k = key(chatId, m[1]!);
    const p = this.#live.get(k);
    if (!p) return this.#anyLive(chatId) ? { kind: "refused", reason: "unknown" } : { kind: "none" };
    if (p.expires <= now) return { kind: "refused", reason: "expired" };
    if (p.used) return { kind: "refused", reason: "replayed" };
    const choiceId = p.codes.get(m[2]!);
    const approver = senderIds.find((id) => p.approverIds.includes(id));
    if (!choiceId || approver === undefined) {
      p.failed += 1;
      if (p.failed >= MAX_FAILED_PER_PROMPT) p.expires = now; // killed: later attempts read as expired
      return { kind: "refused", reason: approver === undefined ? "unauthorized" : "unknown" };
    }
    p.used = true;
    return { kind: "decided", decision: { promptId: p.promptId, chatId, senderId: approver, choiceId } };
  }
  clear(): void {
    this.#live.clear();
  }
  #anyLive(chatId: string): boolean {
    const now = this.#now();
    for (const p of this.#live.values()) if (p.chatId === chatId && p.expires > now && !p.used) return true;
    return false;
  }
  #prune(): void {
    const now = this.#now();
    for (const [k, p] of this.#live) if (p.expires + TOMBSTONE_GRACE_MS <= now) this.#live.delete(k);
  }
}

function key(chatId: string, token: string): string {
  return `${chatId}\u0000${token}`;
}
function randomToken(): string {
  const bytes = randomBytes(TOKEN_LEN);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}
