// DUPLICATE: candidate for shared package (these port types are repeated in every channels-* package on purpose).
import type { ChannelHealth, InboundMessage as FrameworkInbound, OutboundMessage } from "../../core/src/channels/types.ts";

export type { ChannelHealth };

/** Thrown where the platform cannot do what was asked. `code` is always "unsupported". */
export class UnsupportedError extends Error {
  readonly code = "unsupported";
  constructor(what: string) {
    super(`signal does not support ${what}`);
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

export interface Attachment {
  kind: "photo" | "document" | "voice" | "audio" | "video";
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

/** Reference to a message this channel sent. For Signal `messageId` is the send timestamp (ms) as a decimal string. */
export interface SentRef {
  chatId: string;
  messageId: string;
  threadId?: string;
}

/** Transport metadata, not an authenticated harness Principal. Identity resolution belongs to the host. */
export interface RichInbound extends FrameworkInbound {
  readonly sentAt?: number;
  /** Every identifier known for the sender (E.164 number and/or ACI uuid). `senderId` is the number if present. */
  readonly senderIds: readonly string[];
  readonly attachments?: readonly Attachment[];
  /** True when the bot was mentioned (mention placeholder already stripped from `text`) or replied to. */
  readonly addressed: boolean;
  readonly mentioned: boolean;
  readonly quote?: { messageId: string; authorId: string; isBot: boolean };
  readonly reaction?: { emoji: string; targetMessageId: string; targetAuthorId: string; remove: boolean };
  readonly command?: { name: string; argument: string };
  readonly expiresInSeconds?: number;
}

export interface OutboundTurn extends OutboundMessage {
  attachments?: readonly Attachment[];
  /** Signal has no interactive buttons: passing any throws UnsupportedError. Use `prompt()` (reply-code) instead. */
  buttons?: readonly (readonly { text: string; data: string }[])[];
  /** Signal has no threads: ignored. */
  threadId?: string;
  /** Default true: the text is CommonMark and is converted to plain text + textStyle ranges. false = literal text. */
  markdown?: boolean;
}

export type InboundHandler = (message: RichInbound) => void | Promise<void>;

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

export interface SecretReader {
  reveal(name: string): Promise<string | null>;
}
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface ChannelLogger {
  log(level: LogLevel, event: string, attrs: Readonly<Record<string, string | number | boolean>>): void;
}

export type SignalEndpoint = { socketPath: string } | { host: string; port: number };

export interface SignalConfig {
  enabled?: boolean;
  /** The registered signal-cli account, +E.164. */
  account: string;
  endpoint: SignalEndpoint;
  /** Chat ids (group ids, or DM chat ids = sender ids). Empty = nobody. */
  allowlist: readonly string[];
  /** Sender ids (E.164 or uuid) that may DM the bot. Empty = no DMs. */
  dmAllowlist: readonly string[];
  userAllowlist?: readonly string[];
  replyPolicy?: "mention" | "always" | "allowlist";
  maxMediaBytes?: number;
  locale?: "en" | "de";
  /** Plaintext JSON-RPC: only set this for a non-loopback TCP host you trust (e.g. a private tunnel). Default false. */
  allowRemoteEndpoint?: boolean;
}
