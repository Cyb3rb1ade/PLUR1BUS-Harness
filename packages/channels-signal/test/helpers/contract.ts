import manifest from "../../channel.json" with { type: "json" };
import { SignalChannel } from "../../src/index.ts";
import type { ChannelHost } from "../../../core/src/channels/types.ts";
import { FakeDaemon, textEnvelope } from "./fake-daemon.ts";

export interface ContractHarness {
  readonly name: string;
  readonly manifest: unknown;
  readonly channel: SignalChannel;
  readonly secretValues: readonly string[];
  readonly logs: unknown[];
  /** The host the harness channel was started with (also used for the sync point). */
  readonly host: ChannelHost;
  /** Every reason the channel passed to host.fail(). */
  readonly failures: unknown[];
  deliverDirect(text: string): Promise<void>;
  deliverGroupMentioned(text: string): Promise<void>;
  deliverGroupUnmentioned(text: string): Promise<void>;
  sentTexts(): string[];
  withMissingSecret(): Promise<SignalChannel>;
  dispose(): Promise<void>;
}

export const CONTRACT_ACCOUNT = "+4915100000001";
export const CONTRACT_ACCOUNT_UUID = "11111111-2222-4333-8444-555555555555";
export const CONTRACT_DM_SENDER = "+4915100000002";
export const CONTRACT_GROUP = "Zm9vYmFyYmF6cXV4ZmFrZWdyb3VwaWQ=";

/**
 * Signal has no bot credential (the daemon owns the account), so `secretValues` is empty and "missing secret" means an
 * account the daemon does not know. Channels are created unstarted; `deliver*` starts the harness channel on first use.
 */
export async function makeContractHarness(): Promise<ContractHarness> {
  const daemon = new FakeDaemon();
  await daemon.listen();
  const unregistered = new FakeDaemon();
  unregistered.registered = false;
  await unregistered.listen();

  const logs: unknown[] = [];
  const failures: unknown[] = [];
  const logger = {
    log: (level: string, event: string, attrs: Record<string, unknown>) => logs.push({ level, event, ...attrs }),
  };
  const host: ChannelHost = {
    receive: async () => {},
    fail: (err) => {
      failures.push(err);
      logs.push({ level: "error", event: "host.fail", message: String((err as Error).message) });
    },
    log: {
      info: (event, attrs) => logs.push({ level: "info", event, ...(attrs as object) }),
      warn: (event, attrs) => logs.push({ level: "warn", event, ...(attrs as object) }),
      error: (event, attrs) => logs.push({ level: "error", event, ...(attrs as object) }),
    },
  };
  const created: SignalChannel[] = [];
  const make = (d: FakeDaemon): SignalChannel => {
    const c = new SignalChannel({
      account: CONTRACT_ACCOUNT,
      endpoint: { host: "127.0.0.1", port: d.port },
      allowlist: [CONTRACT_GROUP],
      dmAllowlist: [CONTRACT_DM_SENDER],
      replyPolicy: "mention",
      logger,
      sleep: async () => {},
      random: () => 0.5,
      timeout: () => new Promise<void>(() => {}),
    });
    created.push(c);
    return c;
  };
  const channel = make(daemon);
  const ensureStarted = async () => {
    if (!(await channel.health()).ok) await channel.start(host);
  };
  // Each delivery is a distinct message: a real daemon never repeats a timestamp from the same sender, and the channel
  // dedupes on source+timestamp.
  let clock = 1_700_000_000_500;
  const nextTs = () => (clock += 1);
  const deliver = async (env: Record<string, unknown>) => {
    await ensureStarted();
    daemon.push(env);
    // Same-socket ordering: the version reply arrives after the notification, so health() proves it was read.
    await channel.health();
    await channel.whenIdle();
  };

  return {
    name: manifest.name,
    manifest,
    channel,
    secretValues: [],
    logs,
    host,
    failures,
    deliverDirect: (text) => deliver(textEnvelope({ message: text, ts: nextTs() })),
    deliverGroupMentioned: (text) =>
      deliver(
        textEnvelope({
          message: `￼ ${text}`,
          groupId: CONTRACT_GROUP,
          mentions: [{ name: "bot", number: CONTRACT_ACCOUNT, uuid: CONTRACT_ACCOUNT_UUID, start: 0, length: 1 }],
        }),
      ),
    deliverGroupUnmentioned: (text) => deliver(textEnvelope({ message: text, groupId: CONTRACT_GROUP, ts: nextTs() })),
    sentTexts: () => daemon.sent().map((p) => String(p.message ?? "")),
    async withMissingSecret() {
      return make(unregistered);
    },
    async dispose() {
      for (const c of created) await c.stop();
      await daemon.close();
      await unregistered.close();
    },
  };
}
