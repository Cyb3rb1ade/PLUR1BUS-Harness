// DUPLICATE: candidate for shared package (identical shapes live in every channels-* package).
import type { InboundMessage as FrameworkInbound, OutboundMessage } from "../../core/src/channels/types.ts";

export interface SecretReader {
  reveal(name: string): Promise<string | null>;
}
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface ChannelLogger {
  log(level: LogLevel, event: string, attrs: Readonly<Record<string, string | number | boolean>>): void;
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

/** Thrown where the platform cannot do what was asked (code is stable for callers). */
export class UnsupportedError extends Error {
  readonly code = "unsupported";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}

export interface Attachment {
  kind: "photo" | "document" | "voice" | "audio" | "video";
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}
export interface Reaction {
  /** Slack short name without colons, e.g. `thumbsup`. */
  emoji: string;
  /** `ts` of the message that was reacted to. */
  itemTs: string;
}
/** Rich inbound turn. Transport metadata only, never an authenticated harness Principal. */
export interface RichInbound extends FrameworkInbound {
  readonly sentAt?: number;
  /** `thread_ts` of the conversation this message belongs to (also encoded in `chatId` as `<channel>:<thread_ts>`). */
  readonly threadId?: string;
  /** True when the bot was addressed (mention, app_mention, reply in a thread it is part of, DM). */
  readonly mention?: boolean;
  readonly attachments?: readonly Attachment[];
  readonly callback?: { id: string; data: string };
  readonly command?: { name: string; argument: string };
  readonly reaction?: Reaction;
}
export type InboundHandler = (message: RichInbound) => void | Promise<void>;

/** Generic (non-approval) button. Activation is delivered as a rich inbound with `callback`. */
export interface Button {
  text: string;
  data: string;
  /** Restrict activation to one Slack user id. */
  senderId?: string;
  ttlMs?: number;
}
export interface OutboundTurn extends OutboundMessage {
  /** Overrides a thread that is not already part of `chatId`. */
  threadId?: string;
  /** `markdown` (default) converts CommonMark to mrkdwn; `plain` sends the text literally (escaped). */
  format?: "markdown" | "plain";
  attachments?: readonly Attachment[];
  buttons?: readonly (readonly Button[])[];
}
export interface SentRef {
  chatId: string;
  /** Message `ts` for messages, file id (`F...`) for uploaded files. */
  messageId: string;
  kind?: "message" | "file";
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

/** Durable bounded cache of already-handled event ids (Slack redelivers when an ack is late, also across restarts). */
export interface SeenStore {
  load(): Promise<string[] | undefined>;
  save(ids: readonly string[]): Promise<void>;
}
