import type { ChannelHost } from "../../../core/src/channels/types.ts";
import { DiscordChannel, createDiscordChannel, type DiscordConfig, type DiscordDeps } from "../../src/index.ts";
import { BOT_ID, DM_CHANNEL, DM_USER, FakeDiscordRest, FakeGateway, GROUP_USER, GUILD_CHANNEL, OTHER_USER, TOKEN, cdnAwareFetch, snowflake } from "./fake-discord.ts";
import { FakeClock } from "./fake-clock.ts";

/** Shared contract for every channel package: the lead's suite imports these five helpers from here. */
export interface ContractHarness {
  readonly name: string;
  readonly manifest: unknown;
  readonly channel: DiscordChannel;
  readonly secretValues: readonly string[];
  readonly logs: unknown[];
  /** Host bound to `logs`. Pass it to `channel.start(host)`; `failures` records every `host.fail` call. */
  /** Optional extras (not required by the shared contract): the bound host and the recorded host.fail calls. */
  readonly host?: ChannelHost;
  readonly failures?: unknown[];
  deliverDirect(text: string): Promise<void>;
  deliverGroupMentioned(text: string): Promise<void>;
  deliverGroupUnmentioned(text: string): Promise<void>;
  sentTexts(): string[];
  withMissingSecret(): Promise<DiscordChannel>;
  dispose(): Promise<void>;
}

const CONFIG: DiscordConfig = {
  tokenSecret: "discord-bot-token",
  allowlist: [GUILD_CHANNEL],
  dmAllowlist: [DM_USER],
  replyPolicy: "mention",
  locale: "en",
};

const manifest = await import("../../channel.json", { with: { type: "json" } }).then((m) => m.default);

export async function makeContractHarness(): Promise<ContractHarness> {
  const rest = new FakeDiscordRest();
  await rest.listen();
  const gateway = new FakeGateway();
  const clock = new FakeClock();
  const logs: unknown[] = [];
  const failures: unknown[] = [];
  const host: ChannelHost = {
    receive: async (msg) => {
      logs.push({ event: "host.receive", chatId: msg.chatId });
    },
    fail: (err) => {
      failures.push(err);
    },
    log: {
      info: (event, fields) => logs.push({ level: "info", event, ...fields }),
      warn: (event, fields) => logs.push({ level: "warn", event, ...fields }),
      error: (event, fields) => logs.push({ level: "error", event, ...fields }),
    },
  };
  const fetchSeam = cdnAwareFetch(rest);
  const deps = (secret: string | null): DiscordDeps => ({
    secrets: { reveal: async (name) => (name === CONFIG.tokenSecret ? secret : null) },
    logger: { log: (level, event, attrs) => logs.push({ level, event, ...attrs }) },
    baseUrl: `${rest.baseUrl}/api/v10`,
    gatewayUrl: "wss://gateway.test.invalid",
    fetch: fetchSeam,
    webSocket: gateway.factory,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
  });
  const channel = createDiscordChannel(CONFIG, deps(TOKEN));
  const seq = { n: 0 };
  const message = (channelId: string, authorId: string, content: string, extra: Record<string, unknown> = {}) => {
    const id = snowflake(++seq.n + 100);
    return gateway.dispatch("MESSAGE_CREATE", {
      id,
      channel_id: channelId,
      ...(channelId === DM_CHANNEL ? {} : { guild_id: "444000000000000001" }),
      author: { id: authorId, username: "someone" },
      content,
      type: 0,
      timestamp: new Date(clock.now()).toISOString(),
      mentions: [],
      attachments: [],
      ...extra,
    });
  };
  const deliver = async (fn: () => void) => {
    await gateway.whenReady();
    fn();
    await channel.idle();
  };
  return {
    name: "discord",
    manifest,
    channel,
    secretValues: [TOKEN],
    logs,
    host,
    failures,
    deliverDirect: (text) => deliver(() => void message(DM_CHANNEL, DM_USER, text)),
    deliverGroupMentioned: (text) =>
      deliver(() => void message(GUILD_CHANNEL, GROUP_USER, `<@${BOT_ID}> ${text}`, { mentions: [{ id: BOT_ID }] })),
    deliverGroupUnmentioned: (text) => deliver(() => void message(GUILD_CHANNEL, OTHER_USER, text)),
    sentTexts: () =>
      rest.messages.map((m) => m.content.split("​").join("")),
    withMissingSecret: async () => createDiscordChannel(CONFIG, deps(null)),
    dispose: async () => {
      await channel.stop();
      await rest.close();
    },
  };
}
