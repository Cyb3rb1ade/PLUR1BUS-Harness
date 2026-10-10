import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramChannel, MemoryOffsetStore } from "../src/index.ts";
import { outputAttachment, TELEGRAM_PHOTO_MAX_BYTES } from "../src/outputs.ts";
import { createIdentityService } from "../../core/src/identity/service.ts";
import { deriveUserPrincipal } from "../../core/src/identity/principals.ts";
import { OutputStore } from "../../media/src/index.ts";
import { FAKE_TELEGRAM_TOKEN } from "./helpers/fake-telegram.ts";
const token = FAKE_TELEGRAM_TOKEN;
const json = (result: unknown) =>
  new Response(JSON.stringify({ ok: true, result }), {
    headers: { "content-type": "application/json" },
  });
const update = (id: number, text: string, user = 42, kind = "private") => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1,
    chat: { id: 42, type: kind },
    from: { id: user, is_bot: false },
    text,
  },
});
test("Telegram /link consumes code with authenticated bot/sender, rate limits, confirmation gates union", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "telegram-pairing-"));
  const service = createIdentityService({
      dbPath: join(scratch, "identity.sqlite"),
      clock: () => 100,
      audit: () => {},
    }),
    actor = {
      user: "owner",
      host: "test",
      kind: "person" as const,
      role: "owner" as const,
    };
  const human = service.createHuman({ displayName: "Synthetic" }, actor),
    pair = service.startPairing(
      { humanId: human.id, channel: "telegram" },
      actor,
    );
  const replies: string[] = [];
  const channel = new TelegramChannel({
    tokenSecret: "fixture",
    secrets: { reveal: async () => token },
    allowlist: [42],
    offsetStore: new MemoryOffsetStore(),
    mode: "webhook",
    webhook: { url: "https://fixture.invalid/webhook", secret: "test" },
    pairing: service,
    sleep: async () => {},
    fetch: async (url, init) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe")
        return json({ id: 123456789, username: "fixture" });
      if (method === "sendMessage") {
        replies.push(JSON.parse(String(init?.body)).text);
        return json({ message_id: 1 });
      }
      return json(true);
    },
  });
  const send = (u: unknown) =>
    channel.handleWebhook(
      new Request("https://fixture.invalid/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test" },
        body: JSON.stringify(u),
      }),
    );
  try {
    await channel.start();
    await send(update(1, `/link ${pair.code}`));
    assert.equal(
      service.resolvePrincipals(deriveUserPrincipal(human.id)).length,
      1,
    );
    assert.equal(
      service.list({}).pairings[0]!.claimedBy?.accountId,
      "123456789",
    );
    assert.equal(service.list({}).pairings[0]!.claimedBy?.userId, "42");
    assert.match(replies[0]!, new RegExp(`Pairing ID: ${pair.pairingId}`));
    assert.match(replies[0]!, new RegExp(`plur1bus identity approve ${pair.pairingId}`));
    assert.ok(!replies[0]!.includes(pair.code), "the pairing code is not echoed");
    service.confirm({ pairingId: pair.pairingId, approve: true }, actor);
    assert.equal(
      service.resolvePrincipals(deriveUserPrincipal(human.id)).length,
      2,
    );
    await send(update(2, `/link ${pair.code}`));
    assert.match(replies.at(-1)!, /failed/);
    for (let i = 3; i < 8; i++) await send(update(i, "/link BADCODE"));
    const fresh = service.startPairing(
      { humanId: human.id, channel: "telegram" },
      actor,
    );
    await send(update(8, `/link ${fresh.code}`));
    assert.match(replies.at(-1)!, /failed/);
    await send(update(9, `/link ${fresh.code}`, 43, "group"));
    assert.equal(
      service.list({}).pairings.find((p) => p.id === fresh.pairingId)?.state,
      "pending",
    );
  } finally {
    await channel.stop();
    service.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
test("stored image sending requires destination rights, integrity and a bounded compression result", async () => {
  const home = await mkdtemp(join(tmpdir(), "telegram-output-")),
    store = new OutputStore(home),
    id = "00000000-0000-4000-8000-000000000001";
  try {
    await store.put(
      id,
      { prompt: "Synthetic" },
      {
        files: [{ bytes: Buffer.from("image"), format: "png" }],
        metadata: { adapter: "fake", model: "fixture", durationMs: 1 },
      },
    );
    const image = await outputAttachment(
      { store, authorize: async () => true },
      id,
      "42",
    );
    assert.equal(image.kind, "photo");
    assert.equal(Buffer.from(image.data).toString(), "image");
    await assert.rejects(
      () => outputAttachment({ store, authorize: async () => false }, id, "42"),
      /denied/,
    );
    const largeId = "00000000-0000-4000-8000-000000000002";
    await store.put(
      largeId,
      { prompt: "Large" },
      {
        files: [
          { bytes: Buffer.alloc(TELEGRAM_PHOTO_MAX_BYTES + 1), format: "png" },
        ],
        metadata: { adapter: "fake", model: "fixture", durationMs: 1 },
      },
    );
    await assert.rejects(
      () =>
        outputAttachment({ store, authorize: async () => true }, largeId, "42"),
      /compression/,
    );
    let compressed = false;
    const compact = await outputAttachment(
      {
        store,
        authorize: async () => true,
        compress: async (image, max) => {
          assert.equal(max, TELEGRAM_PHOTO_MAX_BYTES);
          compressed = true;
          return { ...image, data: Buffer.from("compressed") };
        },
      },
      largeId,
      "42",
    );
    assert.equal(compressed, true);
    assert.equal(compact.data.length, 10);
    await assert.rejects(
      () =>
        outputAttachment(
          { store, authorize: async () => true },
          "../../secret",
          "42",
        ),
      /denied/,
    );
    let sent = false;
    const channel = new TelegramChannel({
      tokenSecret: "fixture",
      secrets: { reveal: async () => token },
      allowlist: [42],
      offsetStore: new MemoryOffsetStore(),
      outputs: { store, authorize: async () => true },
      mode: "webhook",
      webhook: { url: "https://fixture.invalid/webhook", secret: "test" },
      sleep: async () => {},
      fetch: async (url, init) => {
        const method = String(url).split("/").at(-1);
        if (method === "getMe") return json({ id: 123456789 });
        if (method === "sendPhoto") {
          sent = true;
          assert.ok(init?.body instanceof FormData);
          return json({ message_id: 1 });
        }
        return json(true);
      },
    });
    try {
      await channel.start();
      await channel.sendOutput("42", id);
      assert.equal(sent, true);
    } finally {
      await channel.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
