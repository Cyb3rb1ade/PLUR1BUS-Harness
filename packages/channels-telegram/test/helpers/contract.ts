import { readFileSync } from "node:fs";
import { MemoryOffsetStore, TelegramChannel, type InboundMessage } from "../../src/index.ts";
import type { ChannelHost } from "../../../core/src/channels/types.ts";
import { FakeTelegram, FAKE_TELEGRAM_TOKEN, textUpdate } from "./fake-telegram.ts";

export const CHAT_ID = 42;

export interface LogLine {
  level: string;
  event: string;
  attrs: Record<string, unknown>;
}

export interface ContractHarness {
  readonly name: "telegram";
  readonly manifest: unknown;
  readonly channel: TelegramChannel;
  /** The framework host the channel is started with (receive/fail/log). */
  readonly host: ChannelHost;
  readonly fake: FakeTelegram;
  /** What the channel handed to host.receive, in order. */
  readonly received: InboundMessage[];
  /** What the channel reported through host.fail. */
  readonly failures: unknown[];
  /** Every line the channel wrote to its constructor logger (all levels). */
  readonly logs: LogLine[];
  /** Every line the channel wrote to the host logger (info, warn, error). */
  readonly hostLogs: LogLine[];
  /** Backoff and bucket waits the channel asked for, in milliseconds, in order. */
  readonly sleeps: number[];
  readonly secretValues: readonly string[];
  /** Park sleeps until releaseSleeps() instead of resolving them at once. */
  setHoldSleeps(hold: boolean): void;
  releaseSleeps(): void;
  /** Make every getUpdates fail at the transport level (connection lost) while true. */
  setConnectionDown(down: boolean): void;
  /** Queue an inbound text update from the allowed chat. */
  deliver(text: string, chatId?: number): void;
  sentTexts(): string[];
  /** Resolves once pred() holds; re-checked on every host call and every sleep. Rejects after 5 s. */
  waitFor(pred: () => boolean, what: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Shared contract harness: a real TelegramChannel against the in-process Bot API fake (no real network). */
export async function makeContractHarness(): Promise<ContractHarness> {
  const fake = new FakeTelegram();
  await fake.listen();
  const manifest = JSON.parse(readFileSync(new URL("../../channel.json", import.meta.url), "utf8")) as unknown;

  const received: InboundMessage[] = [];
  const failures: unknown[] = [];
  const logs: LogLine[] = [];
  const hostLogs: LogLine[] = [];
  const sleeps: number[] = [];
  const parked: Array<() => void> = [];
  let holdSleeps = false;
  let connectionDown = false;
  let updateId = 100;

  const waiters = new Set<() => void>();
  const changed = () => {
    for (const w of [...waiters]) w();
  };
  // Predicates may read fake-side state (requests the channel made), which raises no host event; the 1 ms re-check covers that.
  const waitFor = (pred: () => boolean, what: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!pred()) return;
        waiters.delete(check);
        clearInterval(recheck);
        clearTimeout(guard);
        resolve();
      };
      const recheck = setInterval(check, 1);
      // Failure guard only: a healthy run resolves long before this fires.
      const guard = setTimeout(() => {
        waiters.delete(check);
        clearInterval(recheck);
        reject(new Error(`timeout: ${what}`));
      }, 5000);
      waiters.add(check);
      check();
    });

  const realFetch = globalThis.fetch;
  // A lost connection is modelled as a transport failure on getUpdates; everything else reaches the fake.
  const fetchWithOutage: typeof fetch = (input, init) => {
    if (connectionDown && String(input).includes("/getUpdates")) return Promise.reject(new TypeError("fetch failed"));
    return realFetch(input, init);
  };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    sleeps.push(ms);
    changed();
    if (!holdSleeps) return Promise.resolve();
    return new Promise<void>((resolve) => {
      parked.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  const channel = new TelegramChannel({
    tokenSecret: "telegram/bot",
    secrets: { reveal: async () => FAKE_TELEGRAM_TOKEN },
    allowlist: [CHAT_ID],
    offsetStore: new MemoryOffsetStore(),
    logger: { log: (level, event, attrs) => void logs.push({ level, event, attrs }) },
    baseUrl: fake.baseUrl,
    fetch: fetchWithOutage,
    sleep,
    random: () => 0.5,
    pollTimeoutSec: 1,
  });

  const hostLog = (level: string) => (event: string, attrs: Record<string, string | number | boolean>) => {
    hostLogs.push({ level, event, attrs: { ...attrs } });
    changed();
  };
  const host: ChannelHost = {
    receive: async (msg) => {
      received.push(msg);
      changed();
    },
    fail: (err) => {
      failures.push(err);
      changed();
    },
    log: { info: hostLog("info"), warn: hostLog("warn"), error: hostLog("error") },
  };

  return {
    name: "telegram",
    manifest,
    channel,
    host,
    fake,
    received,
    failures,
    logs,
    hostLogs,
    sleeps,
    secretValues: [FAKE_TELEGRAM_TOKEN],
    setHoldSleeps: (hold) => {
      holdSleeps = hold;
    },
    releaseSleeps: () => {
      for (const r of parked.splice(0)) r();
    },
    setConnectionDown: (down) => {
      connectionDown = down;
    },
    deliver: (text, chatId = CHAT_ID) => {
      fake.push(textUpdate(++updateId, chatId, text));
    },
    sentTexts: () => fake.callsOf("sendMessage").map((c) => String(c.body.text)),
    waitFor,
    dispose: async () => {
      holdSleeps = false;
      await channel.stop();
      for (const r of parked.splice(0)) r();
      await fake.close();
    },
  };
}
