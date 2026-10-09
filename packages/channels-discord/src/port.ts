// DUPLICATE: candidate for shared package (identical shapes exist in the other channels-* packages on purpose).
import type { InboundMessage as FrameworkInbound, OutboundMessage } from "../../core/src/channels/types.ts";

export interface ChannelCapabilities {
  threads: boolean;
  edit: boolean;
  typing: boolean;
  attachmentsIn: boolean;
  attachmentsOut: boolean;
  reactions: boolean;
  buttons: boolean;
  approvalMode: "buttons" | "reactions" | "reply-code";
  markdown: "native" | "converted" | "html" | "plain";
  maxMessageChars: number;
}
export interface Attachment {
  kind: "image" | "file" | "audio" | "video";
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}
export interface SentRef {
  chatId: string;
  messageId: string;
}
/** Transport metadata, not an authenticated harness Principal. Identity resolution belongs to the host. */
export interface RichInbound extends FrameworkInbound {
  readonly sentAt?: number;
  readonly guildId?: string;
  /** Set when the message was written inside a thread channel (then `chatId` is the thread id). */
  readonly threadId?: string;
  /** Parent channel of the thread when known. */
  readonly parentId?: string;
  readonly replyToMessageId?: string;
  /** The bot was mentioned or one of its messages was replied to (DMs are always addressed). */
  readonly addressed: boolean;
  readonly attachments?: readonly Attachment[];
}
export interface ApprovalChoice {
  id: string;
  label: string;
}
export interface ApprovalPrompt {
  chatId: string;
  text: string;
  choices: readonly ApprovalChoice[];
  approverIds: readonly string[];
  ttlMs?: number;
  threadId?: string;
}
export interface ApprovalDecision {
  promptId: string;
  chatId: string;
  senderId: string;
  choiceId: string;
  at: number;
}
export interface OutboundTurn extends OutboundMessage {
  /** Threads are chats: when set it must equal `chatId`. */
  threadId?: string;
  attachments?: readonly Attachment[];
  /** Native approval buttons, issued by `prompt`. Handles are opaque, signed, single-use and sender-bound. */
  buttons?: {
    promptId: string;
    choices: readonly ApprovalChoice[];
    approverIds: readonly string[];
    ttlMs?: number;
  };
}
export type InboundHandler = (message: RichInbound) => void | Promise<void>;
export type DecisionHandler = (decision: ApprovalDecision) => void | Promise<void>;
export interface SecretReader {
  reveal(name: string): Promise<string | null>;
}
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface ChannelLogger {
  log(level: LogLevel, event: string, attrs: Readonly<Record<string, string | number | boolean>>): void;
}

/** What is needed to resume a gateway session. `botId` guards against resuming another bot's session after a token swap. */
export interface GatewaySession {
  sessionId: string;
  seq: number;
  resumeGatewayUrl: string;
  botId: string;
}
export interface GatewayStateStore {
  /** Throws (fail closed) when persisted state exists but is unreadable or invalid. */
  load(): Promise<GatewaySession | undefined>;
  save(session: GatewaySession): Promise<void>;
  clear(): Promise<void>;
}

/** The subset of the WHATWG WebSocket (Node's global client) the gateway needs. Tests inject an in-process fake. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export class UnsupportedError extends Error {
  readonly code = "unsupported";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}
