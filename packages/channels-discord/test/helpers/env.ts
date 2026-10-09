import { after } from "node:test";
import type { ChannelHost } from "../../../core/src/channels/types.ts";
import { DiscordChannel, MemoryGatewayStateStore, type DiscordConfig, type DiscordDeps } from "../../src/index.ts";
import { FakeClock } from "./fake-clock.ts";
import { FakeDiscordRest, FakeGateway, TOKEN, cdnAwareFetch } from "./fake-discord.ts";

export interface Env {
  rest: FakeDiscordRest;
  gateway: FakeGateway;
  clock: FakeClock;
  logs: Record<string, unknown>[];
  failures: unknown[];
  host: ChannelHost;
  received: unknown[];
  deps: DiscordDeps;
  cfg: DiscordConfig;
  channel(over?: Partial<DiscordConfig>, extra?: Partial<DiscordDeps>): DiscordChannel;
  /** The most recently built channel. */
  current: DiscordChannel | undefined;
  close(): Promise<void>;
}

export const BASE_CONFIG: DiscordConfig = {
  tokenSecret: "discord-bot-token",
  allowlist: ["555000000000000001"],
  dmAllowlist: ["111000000000000001"],
  replyPolicy: "mention",
  locale: "en",
};

/** Every environment is closed when the file finishes, even if a test threw before its own cleanup. */
const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {});
});

/** Everything in-process: loopback REST stand-in, scripted gateway, virtual clock and a recording host. */
export async function makeEnv(over: Partial<DiscordConfig> = {}, extra: Partial<DiscordDeps> = {}): Promise<Env> {
  const rest = new FakeDiscordRest();
  await rest.listen();
  const gateway = new FakeGateway();
  const clock = new FakeClock();
  const logs: Record<string, unknown>[] = [];
  const failures: unknown[] = [];
  const received: unknown[] = [];
  const host: ChannelHost = {
    receive: async (m) => {
      received.push(m);
    },
    fail: (e) => {
      failures.push(e);
    },
    log: {
      info: (event, fields) => logs.push({ level: "info", event, ...fields }),
      warn: (event, fields) => logs.push({ level: "warn", event, ...fields }),
      error: (event, fields) => logs.push({ level: "error", event, ...fields }),
    },
  };
  const deps: DiscordDeps = {
    secrets: { reveal: async (name) => (name === BASE_CONFIG.tokenSecret ? TOKEN : null) },
    logger: { log: (level, event, attrs) => logs.push({ level, event, ...attrs }) },
    baseUrl: `${rest.baseUrl}/api/v10`,
    gatewayUrl: "wss://gateway.test.invalid",
    cdnHosts: ["cdn.discordapp.com"],
    fetch: cdnAwareFetch(rest),
    webSocket: gateway.factory,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
    stateStore: new MemoryGatewayStateStore(),
    ...extra,
  };
  const cfg: DiscordConfig = { ...BASE_CONFIG, ...over };
  closers.push(() => rest.close());
  const env: Env = {
    rest,
    gateway,
    clock,
    logs,
    failures,
    host,
    received,
    deps,
    cfg,
    current: undefined,
    channel: (o: Partial<DiscordConfig> = {}, e: Partial<DiscordDeps> = {}) => {
      const ch = new DiscordChannel({ ...cfg, ...o, ...deps, ...e });
      env.current = ch;
      return ch;
    },
    close: () => rest.close(),
  };
  return env;
}

/** Starts a channel and waits until the scripted gateway has answered the handshake. */
export async function started(e: Env, ch: DiscordChannel): Promise<void> {
  await ch.start(e.host);
  await e.gateway.whenReady();
}
