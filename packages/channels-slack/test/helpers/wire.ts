import { SlackChannel, type SlackChannelOptions } from "../../src/index.ts";
import type { ChannelHost, InboundMessage } from "../../../core/src/channels/types.ts";
import { FakeSlack, TEST_CONFIG, TEST_SECRETS, quietSleep } from "./fake-slack.ts";

export interface LogLine {
  level: string;
  event: string;
  attrs: Record<string, unknown>;
}
export interface Wiring {
  ch: SlackChannel;
  host: ChannelHost;
  logs: LogLine[];
  received: InboundMessage[];
  failures: unknown[];
  sleeps: number[];
}

/** A channel wired to the fake platform. `extra` overrides any option (e.g. a different config or pairing port). */
export function wire(fake: FakeSlack, extra: Partial<SlackChannelOptions> = {}): Wiring {
  const logs: LogLine[] = [];
  const received: InboundMessage[] = [];
  const failures: unknown[] = [];
  const sleeps: number[] = [];
  const ch = new SlackChannel({
    ...TEST_CONFIG,
    secrets: { reveal: async (name: string) => TEST_SECRETS[name] ?? null },
    baseUrl: fake.baseUrl,
    webSocket: fake.webSocket,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    logger: { log: (level, event, attrs) => void logs.push({ level, event, attrs }) },
    ...extra,
  });
  const line = (level: string) => (event: string, attrs?: Record<string, unknown>) => void logs.push({ level, event, attrs: attrs ?? {} });
  const host: ChannelHost = {
    receive: async (m) => {
      received.push(m);
    },
    fail: (e) => {
      failures.push(e);
    },
    log: { info: line("info"), warn: line("warn"), error: line("error") },
  };
  return { ch, host, logs, received, failures, sleeps };
}

/** Yields until `cond` holds (bounded). Fake time: no wall-clock waits. */
export async function until(cond: () => boolean, label = "condition", max = 500): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export { quietSleep };
