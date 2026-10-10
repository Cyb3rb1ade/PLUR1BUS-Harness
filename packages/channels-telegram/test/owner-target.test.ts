import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { TelegramChannel, MemoryOffsetStore } from "../src/index.ts";
import { FakeTelegram, FAKE_TELEGRAM_TOKEN } from "./helpers/fake-telegram.ts";

const fake = new FakeTelegram();
before(() => fake.listen());
after(() => fake.close());

const ALLOWED_USER = "12345678";
const ALLOWED_GROUP = "-100123456789";
const USER_ALLOWLIST_MEMBER = "87654321";
const STRANGER = "99999999";
const BOT_ID = 999;

function make(over: Partial<ConstructorParameters<typeof TelegramChannel>[0]> = {}) {
  return new TelegramChannel({
    tokenSecret: "channels.telegram.botToken",
    secrets: { reveal: async () => fake.token },
    allowlist: [ALLOWED_USER, ALLOWED_GROUP],
    userAllowlist: [USER_ALLOWLIST_MEMBER],
    offsetStore: new MemoryOffsetStore(),
    baseUrl: fake.baseUrl,
    sleep: async () => {},
    botId: BOT_ID,
    ...over,
  });
}

test("resolveOwnerTarget: allowlisted user id is returned directly as the chat id", async () => {
  const ch = make();
  await ch.start();
  try {
    const target = await ch.resolveOwnerTarget({ userId: ALLOWED_USER });
    assert.equal(target, ALLOWED_USER);

    // Matching accountId also succeeds
    const targetWithAccount = await ch.resolveOwnerTarget({ userId: ALLOWED_USER, accountId: String(BOT_ID) });
    assert.equal(targetWithAccount, ALLOWED_USER);
  } finally {
    await ch.stop();
  }
});

test("resolveOwnerTarget: user on userAllowlist but not allowlist is refused", async () => {
  const ch = make();
  await ch.start();
  try {
    await assert.rejects(
      ch.resolveOwnerTarget({ userId: USER_ALLOWLIST_MEMBER }),
      /user is not on the telegram allowlist/,
    );
  } finally {
    await ch.stop();
  }
});

test("resolveOwnerTarget: refuses a foreign accountId", async () => {
  const ch = make();
  await ch.start();
  try {
    await assert.rejects(
      ch.resolveOwnerTarget({ userId: ALLOWED_USER, accountId: "987654" }),
      /identity belongs to another telegram account/,
    );
  } finally {
    await ch.stop();
  }
});

test("resolveOwnerTarget: refuses invalid user id formats", async () => {
  const ch = make();
  await ch.start();
  try {
    for (const bad of ["@username", "alice", "", "12345:678", "abc123"]) {
      await assert.rejects(ch.resolveOwnerTarget({ userId: bad }), /invalid telegram user id/);
    }
  } finally {
    await ch.stop();
  }
});

test("resolveOwnerTarget: refuses stranger not on allowlist or userAllowlist", async () => {
  const ch = make();
  await ch.start();
  try {
    await assert.rejects(
      ch.resolveOwnerTarget({ userId: STRANGER }),
      /user is not on the telegram allowlist/,
    );
  } finally {
    await ch.stop();
  }
});

test("resolveOwnerTarget: requires channel to be started", async () => {
  const ch = make();
  await assert.rejects(
    ch.resolveOwnerTarget({ userId: ALLOWED_USER }),
    /telegram channel is not started/,
  );
});
