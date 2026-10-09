// DUPLICATE: candidate for shared package (identical shapes live in every channels-* package).
import type { InboundMessage as FrameworkInbound, OutboundMessage } from "../../core/src/channels/types.ts";

export interface SecretReader {
  reveal(name: string): Promise<string | null>;
}
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface ChannelLogger {
  log(level: LogLevel, event: string, attrs: Readonly<Record<string, string | number | boolean>>): void;
}

export interface Attachment {
  kind: "image" | "file" | "audio";
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}
export interface AuthResults {
  spf: string;
  dkim: string;
  dmarc: string;
}
/** Rich inbound turn. `auth` is INFORMATION copied from the receiving MTA's Authentication-Results; nothing is verified here. */
export interface RichInbound extends FrameworkInbound {
  readonly sentAt?: number;
  readonly subject: string;
  readonly attachments?: readonly Attachment[];
  readonly auth: AuthResults;
  /** Message-ID of the mail, without angle brackets. Same as `messageId`. */
  readonly rootMessageId: string;
  readonly command?: { name: string; argument: string };
}
export type InboundHandler = (message: RichInbound) => void | Promise<void>;

export interface OutboundTurn extends OutboundMessage {
  attachments?: readonly Attachment[];
  /** Ignored: the email thread is already encoded in `chatId`. Accepted for API symmetry. */
  threadId?: string;
  /** Subject for a NEW thread (first line of the text is used when omitted). Ignored for replies in a known thread. */
  subject?: string;
}
export interface SentRef {
  chatId: string;
  /** Message-ID of the sent mail, without angle brackets. */
  id: string;
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

export class UnsupportedError extends Error {
  readonly code = "unsupported";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}

/** Persisted mailbox cursor. `uidValidity` + `folder` scope `lastUid`. */
export interface UidState {
  folder: string;
  uidValidity: number;
  lastUid: number;
}
export interface UidStore {
  /** `undefined` = nothing stored yet. Corrupt or unreadable state must THROW (fail closed). */
  load(): Promise<UidState | undefined>;
  save(state: UidState): Promise<void>;
}

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;
