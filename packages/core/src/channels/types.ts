import type { ChannelManifest } from "./manifest.ts";

export type ChatKind = "direct" | "group" | "broadcast";

/** One inbound chat message, already decoded by the channel. `channel` must equal the channel's own name. */
export interface InboundMessage {
  channel: string;
  chatId: string;
  chatKind: ChatKind;
  /** The channel's own id for the sender (Telegram user id, Matrix mxid, …). Never a harness user id. */
  senderId: string;
  accountId?: string;
  text: string;
  messageId?: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  replyTo?: string;
}

export type ChannelHealth = { ok: boolean; detail?: string };

export interface ChannelLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** What a channel is given at `start`. Everything a channel does to the harness goes through this. */
export interface ChannelHost {
  /** Hand an inbound message to the harness. Never rejects; failures are handled (and logged) on the harness side. */
  receive(msg: InboundMessage): Promise<void>;
  /** Report a fatal channel-side failure (connection lost for good, auth revoked). The registry stops and restarts it with backoff. */
  fail(err: unknown): void;
  readonly log: ChannelLogger;
}

/** The channel contract: connect, disconnect, say whether it is alive, deliver an outbound message. */
export interface Channel {
  readonly name: string;
  start(host: ChannelHost): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ChannelHealth>;
  send(msg: OutboundMessage): Promise<void>;
}

export type ChannelFactory = (manifest: ChannelManifest) => Channel;

// --- Ports to layers that are not in the core yet (M3 identity, the `session.*` store). Tests use fakes. ---

export interface SenderRef { channel: string; accountId?: string; senderId: string }
export interface ChatKey { channel: string; chatId: string }

export type IdentityResolution = { linked: true; userId: string } | { linked: false };
export type PairingResult = { ok: true; userId: string } | { ok: false };

/** The pairing hook onto the identity layer (ADR-007). Unlinked channel identities stay unlinked (fail closed). */
export interface IdentityPort {
  resolve(sender: SenderRef): Promise<IdentityResolution>;
  /** Try to redeem a pairing code for this channel identity. Rate limiting and code expiry belong to the store behind it. */
  claimPairing(sender: SenderRef, code: string): Promise<PairingResult>;
}

/** The session store as the channel layer needs it (D21: one active session per channel chat). */
export interface SessionPort {
  findActive(chat: ChatKey): Promise<string | null>;
  create(chat: ChatKey, owner: { userId: string }): Promise<string>;
  archive(sessionId: string): Promise<void>;
  /** `session.submit`: one turn in, the agent's reply out. */
  submit(sessionId: string, input: { userId: string; text: string }): Promise<{ text: string }>;
}
