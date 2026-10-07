// M1b-2c: the session store's and turn loop's shared vocabulary (D92 §2.1, ADR-001, ADR-003).

export const SESSION_KINDS = ["direct", "card", "project", "channel", "acp"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export type MemoryMode = "remember" | "incognito";
export type TurnState = "running" | "completed" | "failed";
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** The events a turn emits (the submit/event contract, ADR-010 L2). `tool.call`/`tool.result` are placeholders: the
 *  loop persists and relays what a provider reports and executes nothing (tools come with M2). */
export const EVENT_TYPES = ["turn.started", "delta", "tool.call", "tool.result", "turn.completed", "turn.failed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface SessionRecord {
  id: string;
  /** I1: immutable. */
  kind: SessionKind;
  /** I1: immutable. */
  agentId: string;
  /** I1: immutable. The user principal hash (`user:v1:<sha256>`), derived by the core from the caller, never supplied. */
  owner: string;
  /** I1: immutable. */
  scope: string;
  /** D21: set on `channel` sessions only; at most one active session per chat key. Immutable. */
  chatKey: string | null;
  title: string;
  pinned: boolean;
  memoryMode: MemoryMode;
  createdAt: number;
  updatedAt: number;
  lastTurnAt: number | null;
  archivedAt: number | null;
  turnCount: number;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  seq: number;
  state: TurnState;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  incognito: boolean;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  turnId: string | null;
  seq: number;
  role: MessageRole;
  text: string;
  tokens: number;
  createdAt: number;
}

export interface EventRecord {
  sessionId: string;
  turnId: string | null;
  seq: number;
  type: EventType;
  data: Record<string, unknown>;
  at: number;
}

export interface SummaryRecord {
  id: string;
  sessionId: string;
  /** The covered message seq range, inclusive. */
  fromSeq: number;
  toSeq: number;
  text: string;
  tokens: number;
  /** Tier 1 summarises messages; tier n+1 summarises tier n summaries (D23 "tiered"). */
  tier: number;
  /** `prepared` (D23 soft threshold) is built but not yet swapped into the context; `applied` is. */
  state: "prepared" | "applied" | "superseded";
  createdAt: number;
}

export interface SearchHit { sessionId: string; messageId: string | null; seq: number | null; snippet: string; rank: number }

export type SessionErrorCode = "invalid" | "not-found" | "conflict" | "immutable" | "storage";
export class SessionError extends Error {
  readonly code: SessionErrorCode;
  readonly reason: string | undefined;
  constructor(code: SessionErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.reason = reason;
  }
}
