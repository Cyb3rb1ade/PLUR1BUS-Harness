import type { Channel, ChannelHealth, ChannelHost, ChatKind, OutboundMessage } from "./types.ts";

/**
 * The reference channel: no network, driven in-process. `inject` plays an inbound chat message, `outbox` collects what the
 * harness sent back. Real channels (Telegram, Discord, …) implement the same `Channel` contract.
 */
export class LoopbackChannel implements Channel {
  readonly name: string;
  readonly outbox: OutboundMessage[] = [];
  #host: ChannelHost | undefined;

  constructor(name = "loopback") { this.name = name; }

  async start(host: ChannelHost): Promise<void> { this.#host = host; }
  async stop(): Promise<void> { this.#host = undefined; }
  async health(): Promise<ChannelHealth> { return this.#host ? { ok: true } : { ok: false, detail: "stopped" }; }
  async send(msg: OutboundMessage): Promise<void> { this.outbox.push(msg); }

  async inject(m: { chatId: string; senderId: string; text: string; chatKind?: ChatKind }): Promise<void> {
    if (!this.#host) throw new Error("loopback channel is not started");
    await this.#host.receive({ channel: this.name, chatKind: "direct", ...m });
  }
}
