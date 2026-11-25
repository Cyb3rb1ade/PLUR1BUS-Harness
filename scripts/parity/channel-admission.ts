import { makeEnv, started } from "../../packages/channels-discord/test/helpers/env.ts";
import { BOT_ID, DM_CHANNEL, DM_USER, snowflake } from "../../packages/channels-discord/test/helpers/fake-discord.ts";
import { BOT_USER, FakeSlack, eventsApi, message } from "../../packages/channels-slack/test/helpers/fake-slack.ts";
import { until, wire } from "../../packages/channels-slack/test/helpers/wire.ts";
import { MemoryOffsetStore, TelegramChannel } from "../../packages/channels-telegram/src/index.ts";
import { FAKE_TELEGRAM_TOKEN } from "../../packages/channels-telegram/test/helpers/fake-telegram.ts";

export async function discordAdmission() {
  const env = await makeEnv();
  const channel = env.channel();
  const authors = [{ id: DM_USER, bot: true }, { id: BOT_ID }, { id: DM_USER }];
  const inputs = authors.map((author, i) => ({
    id: snowflake(100 + i), channel_id: DM_CHANNEL, author, content: "Reply", type: 0,
  }));
  inputs.splice(inputs.length - 1, 0, {
    id: snowflake(110), channel_id: DM_CHANNEL, author: { id: DM_USER }, content: "System event", type: 6,
  });
  try {
    await started(env, channel);
    for (const input of inputs) env.gateway.dispatch("MESSAGE_CREATE", input);
    await until(() => env.received.some((item) => (item as { messageId: string }).messageId === inputs.at(-1)!.id), "Discord delivery");
    await channel.sendTurn({ chatId: DM_CHANNEL, text: "Reply" });
    return {
      botId: BOT_ID, messages: inputs,
      delivered: env.received.map((item) => (item as { messageId: string }).messageId),
      outbound: env.rest.messages[0]!.allowedMentions,
    };
  } finally {
    await channel.stop();
    await env.close();
  }
}

export async function slackAdmission() {
  const fake = new FakeSlack();
  await fake.listen();
  const { ch, host, received } = wire(fake);
  const fields = [
    { user: "UHUMAN01", botId: "BLOCAL01" },
    { user: "UHUMAN01", subtype: "channel_join" },
    { user: BOT_USER },
    { user: "UHUMAN01", subtype: "file_share" },
    { user: "UHUMAN01", subtype: "thread_broadcast" },
    { user: "UHUMAN01" },
  ];
  const envelopes = fields.map((sender, i) => message({
    ...sender, channel: "D0FAKE01", ts: `170000010${i}.000200`, text: "Reply",
    eventId: `fixture-${i}`,
  }));
  envelopes.splice(envelopes.length - 1, 0, eventsApi({
    type: "message", channel: "D0FAKE01", channel_type: "im", user: "UHUMAN01",
    ts: "1700000110.000200", text: "Bot profile", bot_profile: { id: "BLOCAL01" },
  }, { eventId: "fixture-profile" }));
  try {
    await ch.start(host);
    for (const envelope of envelopes) fake.push(envelope);
    const last = envelopes.at(-1)!.payload.event as { ts: string };
    await until(() => received.some((item) => item.messageId === last.ts), "Slack delivery");
    return { botId: BOT_USER, envelopes, delivered: received.map((item) => item.messageId) };
  } finally {
    await ch.stop();
    await fake.close();
  }
}

export async function telegramAdmission() {
  const botId = 123456789;
  const allowlist = [42, botId];
  const delivered: string[] = [];
  const channel = new TelegramChannel({
    tokenSecret: "fixture",
    secrets: { reveal: async () => FAKE_TELEGRAM_TOKEN },
    allowlist: [42],
    userAllowlist: allowlist,
    offsetStore: new MemoryOffsetStore(),
    mode: "webhook",
    webhook: { url: "https://fixture.invalid/webhook", secret: "test" },
    fetch: async (url) => Response.json({
      ok: true, result: String(url).endsWith("/getMe") ? { id: botId, username: "fixture" } : true,
    }),
  });
  const authors = [undefined, { id: 42, is_bot: true }, { id: botId }, { id: 43 }, { id: 42 }];
  const updates = authors.map((from, i) => ({
    update_id: i + 1,
    message: { message_id: i + 1, date: 1, chat: { id: 42, type: "private" }, from, text: "Reply" },
  }));
  try {
    await channel.start({
      receive: async (item) => { delivered.push(item.messageId!); },
      fail: (error) => { throw error; },
      log: { info() {}, warn() {}, error() {} },
    });
    for (const update of updates) {
      const response = await channel.handleWebhook(new Request("https://fixture.invalid/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test" },
        body: JSON.stringify(update),
      }));
      if (!response.ok) throw new Error(`Telegram admission fixture refused with ${response.status}`);
    }
    return { botId, allowlist: allowlist.map(String), updates, delivered };
  } finally {
    await channel.stop();
  }
}
