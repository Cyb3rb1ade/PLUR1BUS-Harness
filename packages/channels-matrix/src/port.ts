// DUPLICATE: candidate for shared package (identical shapes live in every channels-* package of wave 2).
import type { InboundMessage as FrameworkInbound, OutboundMessage } from "../../core/src/channels/types.ts";

export interface SecretReader {
  reveal(name: string): Promise<string | null>;
}
export type LogLevel = "debug" | "info" | "warn" | "error";
/** Structured, content-free log sink. Attribute values are scalars; never message text, codes or credentials. */
export interface ChannelLogger {
  log(level: LogLevel, event: string, attrs: Readonly<Record<string, string | number | boolean>>): void;
}

export interface Attachment {
  kind: "photo" | "document" | "voice" | "audio" | "video";
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

/** Framework message plus everything the text-only core contract cannot carry. Transport metadata, not a Principal. */
export interface RichInbound extends FrameworkInbound {
  /** The Matrix room id (chatId minus an optional thread suffix). */
  readonly roomId: string;
  readonly sentAt?: number;
  /** Thread root event id when the message belongs to an `m.thread`. */
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  /** True in DMs, and in groups when the bot was mentioned / replied to / is in its own thread. */
  readonly addressed: boolean;
  readonly msgtype: string;
  readonly attachments?: readonly Attachment[];
  readonly command?: { name: string; argument: string };
}

export interface OutboundTurn extends OutboundMessage {
  /** Thread root event id; alternatively encode it in chatId as `<roomId>:<threadRootEventId>`. */
  threadId?: string;
  attachments?: readonly Attachment[];
  /** Send as `m.notice` (bot status text) instead of `m.text`. */
  notice?: boolean;
}
export interface SentRef {
  chatId: string;
  messageId: string;
}

export class UnsupportedError extends Error {
  readonly code = "unsupported";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}

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

export type ApprovalChoice = { id: string; label: string };
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

/** Persistent `/sync` position. Required: without it a restart would either replay or silently skip history. */
export interface SyncTokenStore {
  /** `undefined` = no state yet (first run). Must THROW on unreadable/corrupt state: the channel then fails closed. */
  load(): Promise<string | undefined>;
  save(token: string): Promise<void>;
}
