// The real Telegram adapter behind the switchboard host, against the channel's own in-process fake Telegram Bot API.
// No network, no sleeps: the adapter's clock is the virtual clock, waiting is `e2e.until` (event-loop turns).
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "./e2e-assert.ts";
import { startE2e, type E2e } from "./e2e-rig.ts";
import { OWNER, type ApprovalView } from "./switchboard-rig.ts";
import { TEST_MESSAGE } from "../../src/rpc/channel-surface.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { OutputStore } from "../../../media/src/index.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  FakeTelegram,
  FAKE_TELEGRAM_TOKEN,
  textUpdate,
} from "../../../channels-telegram/test/helpers/fake-telegram.ts";

const BOT_ID = 999;
const BOT_USERNAME = "testbot";
const DM_USER = "424242";
const OTHER_USER = "848484";
const GROUP_CHAT = "-100123456789";

interface Env2 {
  e2e: E2e;
  fake: FakeTelegram;
  close(): Promise<void>;
}

async function start(o: { config?: Record<string, unknown>; deps?: Record<string, unknown> } = {}): Promise<Env2> {
  const fake = new FakeTelegram();
  await fake.listen();
  const e2e = await startE2e({
    id: "telegram",
    secrets: { "channels.telegram.botToken": FAKE_TELEGRAM_TOKEN },
    config: {
      tokenSecret: "channels.telegram.botToken",
      allowlist: [DM_USER, OTHER_USER, GROUP_CHAT],
      botId: BOT_ID,
      botUsername: BOT_USERNAME,
      pollTimeoutSec: 1,
      ...(o.config ?? {}),
    },
    adapterDeps: {
      baseUrl: fake.baseUrl,
      sleep: async () => {},
      random: () => 0.5,
      ...(o.deps ?? {}),
    },
  });
  await e2e.until(() => e2e.switchboard.view.status("telegram")?.state === "running", "the telegram channel runs");
  return {
    e2e,
    fake,
    close: async () => {
      await e2e.switchboard.stop();
      e2e.identity.close();
      e2e.store.close?.();
      await fake.close();
    },
  };
}

let updateSeq = 100;
const nextUpdateId = () => ++updateSeq;

const toChat = (f: FakeTelegram, chat: string | number = DM_USER) =>
  f.callsOf("sendMessage").filter((c) => String(c.body.chat_id) === String(chat));

test("a linked person's DM runs a turn and the echo reply reaches the Telegram chat", async () => {
  const t = await start();
  try {
    t.e2e.link("telegram", String(BOT_ID), DM_USER);
    t.fake.push(textUpdate(nextUpdateId(), Number(DM_USER), "hello"));
    await t.e2e.until(() => toChat(t.fake).some((c) => String(c.body.text).includes("echo:hello")), "the echo reply");
    assert.equal(t.e2e.provider.requests.length, 1);
  } finally {
    await t.close();
  }
});

test("an unlinked sender gets the pairing notice only; no turn runs", async () => {
  const t = await start();
  try {
    t.fake.push(textUpdate(nextUpdateId(), Number(DM_USER), "hello"));
    await t.e2e.until(() => toChat(t.fake).length === 1, "the pairing notice");
    assert.match(String(toChat(t.fake)[0]!.body.text), /not paired/i);
    assert.equal(t.e2e.provider.requests.length, 0);
  } finally {
    await t.close();
  }
});

test("channel.test --send-owner delivers directly to the user id (chat id)", async () => {
  const t = await start();
  try {
    const { humanId } = t.e2e.link("telegram", String(BOT_ID), DM_USER);
    const out = await t.e2e.call("channel.test", { id: "telegram", sendOwner: true }, humanId);
    assert.equal(out.sent, true);
    const sent = toChat(t.fake);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.body.text, TEST_MESSAGE);
    assert.equal(String(sent[0]!.body.chat_id), DM_USER);
  } finally {
    await t.close();
  }
});

test("--send-owner for a linked user off the allowlist fails and sends nothing", async () => {
  const t = await start({ config: { allowlist: [OTHER_USER] } });
  try {
    const { humanId } = t.e2e.link("telegram", String(BOT_ID), DM_USER);
    await assert.rejects(t.e2e.call("channel.test", { id: "telegram", sendOwner: true }, humanId), /could not be sent/);
    assert.equal(toChat(t.fake).length, 0);
  } finally {
    await t.close();
  }
});

test("/link <code> pairs through the hosted adapter", async () => {
  const t = await start();
  try {
    const human = t.e2e.identity.createHuman({ displayName: "Pat" }, OWNER);
    const { code } = t.e2e.identity.startPairing(
      { humanId: human.id, channel: "telegram" },
      { user: human.id, host: "test", kind: "person", role: "member" },
    );
    t.fake.push(textUpdate(nextUpdateId(), Number(DM_USER), `/link ${code}`));
    await t.e2e.until(() => toChat(t.fake).length >= 1, "the answer to /link");
    const claimed = t.e2e.identity.list({}).pairings.filter((p) => p.state === "claimed");
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.claimedBy?.accountId, String(BOT_ID));
    assert.equal(claimed[0]!.claimedBy?.userId, DM_USER);
    assert.ok(!JSON.stringify(t.fake.callsOf("sendMessage")).includes(code), "the code is never echoed");
  } finally {
    await t.close();
  }
});

test("an image a tool produced follows the text reply into the chat via sendOutput", async () => {
  const root = tempDir("e2e-telegram-media-");
  const outId = "11111111-2222-3333-4444-555555555555";
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  mkdirSync(join(root, outId), { recursive: true });
  writeFileSync(join(root, outId, "0.png"), png);
  writeFileSync(
    join(root, outId, "manifest.json"),
    JSON.stringify({
      id: outId,
      files: [{ path: "0.png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), format: "png" }],
    }),
  );
  const asked: string[] = [];
  const outputs = {
    store: new OutputStore(root),
    authorize: async (id: string, chat: string) => {
      asked.push(`${id}@${chat}`);
      return id === outId && chat === DM_USER;
    },
  };
  const t = await start({ deps: { outputs } });
  try {
    t.e2e.link("telegram", String(BOT_ID), DM_USER);
    t.e2e.provider.script = () => [
      { type: "tool.result", id: "t1", output: JSON.stringify({ id: outId, files: [{ path: "0.png", format: "png" }] }) },
      { type: "delta", text: "here is your picture" },
    ];
    t.fake.push(textUpdate(nextUpdateId(), Number(DM_USER), "draw"));
    await t.e2e.until(
      () => t.fake.callsOf("sendMessage").length >= 1 && t.fake.callsOf("sendPhoto").length >= 1,
      "text reply and image",
    );
    const texts = t.fake.callsOf("sendMessage");
    const photos = t.fake.callsOf("sendPhoto");
    assert.ok(texts.some((c) => String(c.body.text).includes("here is your picture")));
    assert.equal(photos.length, 1);
    assert.equal(String(photos[0]!.body.chat_id), DM_USER);
    assert.deepEqual(asked, [`${outId}@${DM_USER}`]);
  } finally {
    await t.close();
  }
});
