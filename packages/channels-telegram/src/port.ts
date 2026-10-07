import type { InboundMessage as FrameworkInbound, OutboundMessage } from "../../core/src/channels/types.ts";

/** Transport metadata, not an authenticated harness Principal. Identity resolution belongs to the host. */
export interface InboundMessage extends FrameworkInbound {
  readonly sentAt?: number;
  readonly threadId?: number;
  readonly attachments?: readonly Attachment[];
  readonly callback?: { id: string; data: string };
  readonly command?: { name: string; argument: string };
}
export interface Attachment {
  kind: "photo" | "document" | "voice" | "audio" | "video";
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}
export interface Button {
  text: string;
  data: string;
  senderId?: string;
  ttlMs?: number;
}
export interface TextEntity {
  type: "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "code" | "pre";
  offset: number;
  length: number;
  language?: string;
}
export interface OutboundTurn extends OutboundMessage {
  /** UTF-16 offsets, as in the Bot API. Code/pre blocks reopen on every chunk. Mutually exclusive with parseMode. */
  entities?: readonly TextEntity[];
  attachments?: readonly Attachment[];
  buttons?: readonly (readonly Button[])[];
  /** Input is literal text. It is escaped before parse_mode is applied. */
  parseMode?: "MarkdownV2" | "HTML";
}
export type InboundHandler = (message: InboundMessage) => void | Promise<void>;
export interface SecretReader {
  reveal(name: string): Promise<string | null>;
}
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface ChannelLogger {
  log(level: LogLevel, event: string, attrs: Readonly<Record<string, string | number | boolean>>): void;
}
export interface OffsetStore {
  load(): Promise<number | undefined>;
  save(offset: number): Promise<void>;
  /** Optional durable migration journal. FileOffsetStore implements both. */
  loadMigrations?(): Promise<Readonly<Record<string, string>>>;
  saveMigration?(from: string, to: string): Promise<void>;
}
export interface WebLinkProvider {
  /** Must resolve a linked person and issue a single-use D93 link; never trust senderId as a Principal. */
  createLink(message: InboundMessage): Promise<string>;
}
/** Future D109 binding must authenticate the principal and authorize the actual approval. */
export interface ConfirmPrompt {
  prompt(chatId: string, text: string, buttons: readonly (readonly Button[])[]): Promise<readonly string[]>;
}
export interface ChannelPort {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: InboundHandler): () => void;
  send(chatId: string, text: string): Promise<readonly string[]>;
}
