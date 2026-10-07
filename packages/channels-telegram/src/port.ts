// The narrow channel port this package implements. The A3 channel framework was not on main when A4 was built, so the
// shapes live here; A3 adopts them or wraps them in an adapter. Nothing in this file is Telegram-specific.

export interface InboundMessage {
  readonly channel: string;
  /** Opaque, channel-scoped conversation id (a decimal string for Telegram, negative for groups). */
  readonly chatId: string;
  readonly messageId: string;
  /** Opaque sender id when the channel provides one. */
  readonly senderId?: string;
  readonly text: string;
  /** Milliseconds since the epoch, as reported by the channel. */
  readonly sentAt: number;
}

export type InboundHandler = (message: InboundMessage) => void | Promise<void>;

export interface ChannelPort {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Returns an unsubscribe function. */
  onMessage(handler: InboundHandler): () => void;
  /** Sends text to an allowed conversation; long text is split. Returns the channel's message ids in order. */
  send(chatId: string, text: string): Promise<readonly string[]>;
}

/** The one capability of the secret store (M2) this channel needs. Returns null when the name is absent. */
export interface SecretReader {
  reveal(name: string): Promise<string | null>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
/** Attributes are redacted by the channel before they reach this logger; they never contain message text. */
export interface ChannelLogger {
  log(level: LogLevel, event: string, attrs: Readonly<Record<string, string | number | boolean>>): void;
}

export interface OffsetStore {
  /** The next `offset` to request, or undefined when nothing was stored (or the stored state is unreadable). */
  load(): Promise<number | undefined>;
  save(offset: number): Promise<void>;
}
