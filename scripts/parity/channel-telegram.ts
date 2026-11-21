import { TelegramChannel } from "../../packages/channels-telegram/src/channel.ts";
import { MemoryOffsetStore } from "../../packages/channels-telegram/src/offset.ts";
import { FakeTelegram, textUpdate } from "../../packages/channels-telegram/test/helpers/fake-telegram.ts";

export async function telegramWebhook() {
  const fake = new FakeTelegram();
  const secret = "synthetic-webhook-marker";
  const wrong = "incorrect-fixture-value";
  const maxBodyBytes = 512;
  const target = "https://fixture.invalid/telegram";
  await fake.listen();
  const channel = new TelegramChannel({
    tokenSecret: "fixture", secrets: { reveal: async () => fake.token },
    allowlist: [42], offsetStore: new MemoryOffsetStore(), baseUrl: fake.baseUrl,
    mode: "webhook", webhook: { url: target, secret, maxBodyBytes },
  });
  const delivered: string[] = [];
  const cases = [];
  const good = textUpdate(10, 42, "Hallo 👋");
  const input = [
    { name: "get", method: "GET", correct: true },
    { name: "wrong-secret", method: "POST", correct: false, body: JSON.stringify(good) },
    { name: "missing-body", method: "POST", correct: true },
    { name: "bad-json", method: "POST", correct: true, body: "{" },
    { name: "oversize", method: "POST", correct: true, body: "x".repeat(513) },
    { name: "negative-id", method: "POST", correct: true, body: JSON.stringify({ ...good, update_id: -1 }) },
    { name: "normal-update", method: "POST", correct: true, body: JSON.stringify(good) },
    { name: "duplicate", method: "POST", correct: true, body: JSON.stringify(good) },
  ];
  try {
    await channel.start({
      receive: async (msg) => { delivered.push(msg.text); },
      fail: () => {}, log: { info() {}, warn() {}, error() {} },
    });
    for (const row of input) {
      const response = await channel.handleWebhook(new Request(target, {
        method: row.method, headers: { "X-Telegram-Bot-Api-Secret-Token": row.correct ? secret : wrong },
        body: row.body,
      }));
      cases.push({ ...row, response: { status: response.status }, delivered: delivered.length });
    }
    return { schema: "plur1bus.parity-webhook/1", source: "packages/channels-telegram/src/channel.ts", cases, maxBodyBytes };
  } finally {
    await channel.stop();
    await fake.close();
  }
}
