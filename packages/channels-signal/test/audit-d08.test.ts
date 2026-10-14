import assert from "node:assert/strict";
import { test } from "node:test";
import { DM, DM_UUID, GROUP, push, rig, ACCOUNT } from "./helpers/setup.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";
import { redactString } from "../src/redact.ts";

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

test("audit: notifications for another account on a shared daemon are ignored", async () => {
  const r = await rig();
  try {
    r.daemon.push(textEnvelope({ message: "hallo" }), "+4915199999999");
    await r.ch.health();
    await r.ch.whenIdle();
    assert.equal(r.received.length, 0);
    assert.equal(r.daemon.callsOf("send").length, 0);
  } finally {
    await r.close();
  }
});

test("audit: a sender identifier shaped like an allowlisted group id is not a DM identity", async () => {
  const r = await rig();
  try {
    const env = textEnvelope({ message: "spoof" });
    env.source = GROUP;
    env.sourceNumber = GROUP;
    delete env.sourceUuid;
    await push(r, env);
    assert.equal(r.received.length, 0);
    assert.equal(r.daemon.callsOf("send").length, 0);
  } finally {
    await r.close();
  }
});

test("audit: DM allowlisted by uuid only still gets replies addressed to that uuid", async () => {
  const r = await rig({ dmAllowlist: [DM_UUID] });
  try {
    await push(r, textEnvelope({ message: "/help" }));
    const sent = r.daemon.sent();
    assert.equal(sent.length, 1, "help reply must be delivered");
    assert.deepEqual(sent[0]!.recipient, [DM_UUID]);
  } finally {
    await r.close();
  }
});

for (const [raw, expected] of [
  ["..", undefined],
  [".", undefined],
  ["...", undefined],
  [".bashrc", "bashrc"],
  ["../../x.png", "x.png"],
] as const)
  test(`audit: inbound attachment filename ${JSON.stringify(raw)} is never a dot-segment or hidden name`, async () => {
    const r = await rig();
    r.daemon.attachments.set("att1", PNG);
    const names: Array<string | undefined> = [];
    r.ch.onMessage((m) => void (m.attachments ?? []).forEach((a) => names.push(a.filename)));
    try {
      await push(r, textEnvelope({ message: "x", attachments: [{ id: "att1", contentType: "image/png", size: 8, filename: raw }] }));
      assert.deepEqual(names, [expected]);
    } finally {
      await r.close();
    }
  });

test("audit: outbound attachment named '..' is sent under a neutral name", async () => {
  const r = await rig();
  try {
    await r.ch.sendTurn({ chatId: DM, text: "", markdown: false, attachments: [{ kind: "document", data: new Uint8Array([1]), mimeType: "application/pdf", filename: ".." }] });
    assert.ok(!String(r.daemon.sent()[0]!.attachments[0]).includes("filename=.."));
  } finally {
    await r.close();
  }
});

test("audit: an invalid outbound attachment is refused before any text chunk is sent", async () => {
  const r = await rig();
  try {
    await assert.rejects(
      r.ch.sendTurn({ chatId: DM, text: "hello", attachments: [{ kind: "document", data: new Uint8Array([1]), mimeType: "text/html" }] }),
    );
    assert.equal(r.daemon.callsOf("send").length, 0);
  } finally {
    await r.close();
  }
});

test("audit: the number of inbound attachments per message is capped", async () => {
  const r = await rig();
  r.daemon.attachments.set("att1", PNG);
  try {
    const atts = Array.from({ length: 40 }, () => ({ id: "att1", contentType: "image/png", size: 8 }));
    await push(r, textEnvelope({ message: "many", attachments: atts }));
    assert.equal(r.received.length, 0);
    assert.ok(r.daemon.callsOf("getAttachment").length <= 10, "must not fetch every attachment");
  } finally {
    await r.close();
  }
});

test("audit: redactString removes the known account also without its plus sign", () => {
  const out = redactString(`failed for ${ACCOUNT.slice(1)} now`, ACCOUNT);
  assert.ok(!out.includes(ACCOUNT.slice(1)), out);
});

test("audit: a flood of notifications is bounded in the inbound queue", async () => {
  const r = await rig();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let handled = 0;
  r.ch.onMessage(async () => {
    handled += 1;
    await gate;
  });
  try {
    for (let i = 0; i < 1200; i++) r.daemon.push(textEnvelope({ message: "m", ts: 1_700_000_001_000 + i }));
    await r.ch.health();
    release();
    await r.ch.whenIdle();
    await r.ch.health();
    await r.ch.whenIdle();
    assert.ok(handled < 1200, `handled ${handled}`);
    assert.ok(r.logs.some((l) => l.event === "channel.signal.queue-full"));
  } finally {
    release();
    await r.close();
  }
});
