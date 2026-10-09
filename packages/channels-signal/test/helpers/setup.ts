import { SignalChannel, type RichInbound, type SignalChannelOptions } from "../../src/index.ts";
import type { ChannelHost } from "../../../core/src/channels/types.ts";
import { FakeDaemon } from "./fake-daemon.ts";

export const ACCOUNT = "+4915100000001";
export const BOT_UUID = "11111111-2222-4333-8444-555555555555";
export const DM = "+4915100000002";
export const DM_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const GROUP = "Zm9vYmFyYmF6cXV4ZmFrZWdyb3VwaWQ=";
export const STRANGER = "+4915100000009";

export interface Rig {
  daemon: FakeDaemon;
  ch: SignalChannel;
  host: ChannelHost;
  received: RichInbound[];
  failures: unknown[];
  logs: Array<Record<string, unknown>>;
  sleeps: number[];
  now: { t: number };
  close(): Promise<void>;
}

/** A started (or not) channel against a fresh fake daemon. Timers are virtual: sleep records and returns at once. */
export async function rig(over: Partial<SignalChannelOptions> = {}, start = true): Promise<Rig> {
  const daemon = new FakeDaemon();
  await daemon.listen();
  const received: RichInbound[] = [];
  const failures: unknown[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  const now = { t: 1_700_000_000_000 };
  const logger = { log: (level: string, event: string, attrs: Record<string, unknown>) => logs.push({ level, event, ...attrs }) };
  const host: ChannelHost = {
    receive: async (m) => {
      received.push(m as RichInbound);
    },
    fail: (e) => failures.push(e),
    log: {
      info: (event, attrs) => logs.push({ level: "info", event, ...(attrs as object) }),
      warn: (event, attrs) => logs.push({ level: "warn", event, ...(attrs as object) }),
      error: (event, attrs) => logs.push({ level: "error", event, ...(attrs as object) }),
    },
  };
  const ch = new SignalChannel({
    account: ACCOUNT,
    endpoint: { host: "127.0.0.1", port: daemon.port },
    allowlist: [GROUP],
    dmAllowlist: [DM],
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => now.t,
    timeout: () => new Promise<void>(() => {}),
    ...over,
  });
  if (start) await ch.start(host);
  return {
    daemon,
    ch,
    host,
    received,
    failures,
    logs,
    sleeps,
    now,
    async close() {
      await ch.stop();
      await daemon.close();
    },
  };
}

/** Pushes one envelope and waits until the channel has processed it (see contract.ts for the ordering argument). */
export async function push(r: Rig, env: Record<string, unknown>): Promise<void> {
  r.daemon.push(env);
  await r.ch.health();
  await r.ch.whenIdle();
}
