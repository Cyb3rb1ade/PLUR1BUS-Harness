import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { FakeSlack, BOT_USER, slash } from "./helpers/fake-slack.ts";
import { wire, type Wiring } from "./helpers/wire.ts";

let fake: FakeSlack;
let w: Wiring;
beforeEach(async () => {
  fake = new FakeSlack();
  await fake.listen();
});
afterEach(async () => {
  await w?.ch.stop();
  await fake.close();
});

const CODE = "PAIR-7Q2X-FAKECODE-DONOTLOG";
function pairing(fail = false) {
  const calls: Array<{ code: string; identity: unknown }> = [];
  return {
    calls,
    port: {
      claim: (p: { code: string; identity: unknown }) => {
        calls.push(p);
        if (fail) throw new Error(`no such code ${p.code}`);
        return { pairingId: "p1", state: "awaiting-confirmation", confirmBy: 0 };
      },
    } as never,
  };
}
async function run(env: ReturnType<typeof slash>, extra: Parameters<typeof wire>[1] = {}) {
  w = wire(fake, extra);
  await w.ch.start(w.host);
  fake.push(env);
  await w.ch.idle();
  return fake.callsOf("chat.postEphemeral").map((c) => ({ user: c.body.user, channel: c.body.channel, text: String(c.body.text) }));
}

test("/plur1bus link CODE in a DM claims the pairing with the bot id and the sender id", async () => {
  const p = pairing();
  const replies = await run(slash({ user: "UHUMAN01", channel: "D0FAKE01", text: `link ${CODE}`, channelName: "directmessage" }), { pairing: p.port });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0]!.code, CODE);
  assert.deepEqual(p.calls[0]!.identity, { channel: "slack", accountId: BOT_USER, userId: "UHUMAN01" });
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.user, "UHUMAN01");
  assert.match(replies[0]!.text, /Pairing claimed/);
});

test("link outside a DM is refused: no claim, no code use", async () => {
  const p = pairing();
  const replies = await run(slash({ user: "UHUMAN01", channel: "C0FAKE01", text: `link ${CODE}`, channelName: "general" }), { pairing: p.port });
  assert.equal(p.calls.length, 0);
  assert.match(replies[0]!.text, /direct message/);
});

test("every failure yields the same uniform reply and the code never appears in logs or replies", async () => {
  const p = pairing(true);
  const replies = await run(slash({ user: "UHUMAN01", channel: "D0FAKE01", text: `link ${CODE}` }), { pairing: p.port });
  assert.equal(replies[0]!.text, "Pairing failed. Request a new code in My identities.");
  assert.doesNotMatch(JSON.stringify(replies), /PAIR-7Q2X/);
  assert.doesNotMatch(JSON.stringify(w.logs), /PAIR-7Q2X|FAKECODE/);
});

test("link without a pairing port is not offered; the usage line leaves it out", async () => {
  const replies = await run(slash({ user: "UHUMAN01", channel: "D0FAKE01", text: "link X" }));
  assert.doesNotMatch(replies[0]!.text, /link/);
});

test("usage advertises link only when pairing exists", async () => {
  const p = pairing();
  const withPair = await run(slash({ user: "UHUMAN01", channel: "D0FAKE01", text: "help" }), { pairing: p.port });
  assert.match(withPair[0]!.text, /link CODE/);
});

test("status replies with a connected line; unknown subcommands get usage", async () => {
  const s = await run(slash({ user: "UHUMAN01", channel: "D0FAKE01", text: "status" }));
  assert.match(s[0]!.text, /connected/);
});

test("a command for another app is ignored", async () => {
  const env = slash({ user: "UHUMAN01", channel: "D0FAKE01", text: "status" });
  (env.payload as Record<string, unknown>).command = "/other";
  const replies = await run(env);
  assert.equal(replies.length, 0);
});
