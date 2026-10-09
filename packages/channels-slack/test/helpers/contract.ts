import { readFileSync } from "node:fs";
import { FakeSlack, FAKE_APP_TOKEN, FAKE_BOT_TOKEN, TEST_CONFIG, eventsApi, message, quietSleep } from "./fake-slack.ts";
import { SlackChannel, slackToPlain } from "../../src/index.ts";

export interface ContractHarness {
  readonly name: string;
  readonly manifest: unknown;
  readonly channel: SlackChannel;
  readonly secretValues: readonly string[];
  readonly logs: unknown[];
  deliverDirect(text: string): Promise<void>;
  deliverGroupMentioned(text: string): Promise<void>;
  deliverGroupUnmentioned(text: string): Promise<void>;
  sentTexts(): string[];
  withMissingSecret(): Promise<SlackChannel>;
  dispose(): Promise<void>;
}

const DM = "D0FAKE01";
const GROUP = "C0FAKE01";
const HUMAN = "UHUMAN01";

/** Shared contract harness: a fully wired SlackChannel against the in-process fake Web API and Socket Mode hub. */
export async function makeContractHarness(): Promise<ContractHarness> {
  const fake = new FakeSlack();
  await fake.listen();
  const logs: unknown[] = [];
  const manifest = JSON.parse(readFileSync(new URL("../../channel.json", import.meta.url), "utf8")) as unknown;
  const build = (secrets: { reveal(name: string): Promise<string | null> }): SlackChannel =>
    new SlackChannel({
      ...TEST_CONFIG,
      secrets,
      baseUrl: fake.baseUrl,
      webSocket: fake.webSocket,
      sleep: quietSleep,
      random: () => 0.5,
      logger: { log: (level, event, attrs) => void logs.push({ level, event, ...attrs }) },
    });
  const secrets = { reveal: async (name: string) => (name === "slack-bot-token" ? FAKE_BOT_TOKEN : name === "slack-app-token" ? FAKE_APP_TOKEN : null) };
  const channel = build(secrets);
  let ts = 1_700_200_000;
  const deliver = async (text: string, channelId: string, channelType: "im" | "channel", user: string, mention: boolean) => {
    if (!fake.sockets.some((s) => !s.closed)) throw new Error("harness channel is not started");
    ts += 1;
    const body = mention ? `<@${"UBOT0001"}> ${text}` : text;
    fake.push(message({ channel: channelId, channelType, user, text: body, ts: `${ts}.000100` }));
    await channel.idle();
  };
  return {
    name: "slack",
    manifest,
    channel,
    secretValues: [FAKE_BOT_TOKEN, FAKE_APP_TOKEN],
    logs,
    deliverDirect: (text) => deliver(text, DM, "im", HUMAN, false),
    deliverGroupMentioned: (text) => deliver(text, GROUP, "channel", HUMAN, true),
    deliverGroupUnmentioned: (text) => deliver(text, GROUP, "channel", HUMAN, false),
    sentTexts: () => fake.postedTexts().map((t) => slackToPlain(t)),
    withMissingSecret: async () => build({ reveal: async () => null }),
    dispose: async () => {
      await channel.stop();
      await fake.close();
    },
  };
}

export { eventsApi };
