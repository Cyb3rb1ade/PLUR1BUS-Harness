import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGES, type ApprovalDecision } from "../src/index.ts";
import { makeEnv, started, type Env } from "./helpers/env.ts";
import { BOT_ID, DM_CHANNEL, DM_USER, GROUP_USER, GUILD_CHANNEL, OTHER_USER, TOKEN, snowflake } from "./helpers/fake-discord.ts";

const NOT_ALLOWED_CHANNEL = "888000000000000001";
let seq = 0;
const interactionId = () => snowflake(++seq + 9000);

function interact(e: Env, body: Record<string, unknown>): void {
  e.gateway.dispatch("INTERACTION_CREATE", {
    id: interactionId(),
    token: "interactiontoken0123456789abcdef",
    ...body,
  });
}
async function act(e: Env, body: Record<string, unknown>): Promise<void> {
  await e.gateway.whenReady();
  interact(e, body);
  await e.current!.idle();
}
function press(e: Env, customId: string, opts: { user?: string; channel?: string } = {}): Promise<void> {
  const user = opts.user ?? GROUP_USER;
  return act(e, {
    type: 3,
    channel_id: opts.channel ?? GUILD_CHANNEL,
    guild_id: "444000000000000001",
    member: { user: { id: user } },
    data: { custom_id: customId, component_type: 2 },
  });
}
function command(e: Env, name: string, opts: { options?: { name: string; type: number; value: string }[]; guild?: boolean; user?: string; bot?: boolean } = {}): Promise<void> {
  const user = { id: opts.user ?? DM_USER, ...(opts.bot ? { bot: true } : {}) };
  return act(e, {
    type: 2,
    channel_id: opts.guild ? GUILD_CHANNEL : DM_CHANNEL,
    ...(opts.guild ? { guild_id: "444000000000000001", member: { user } } : { user }),
    data: { name, type: 1, ...(opts.options ? { options: opts.options } : {}) },
  });
}
const lastPrompt = (e: Env) => e.rest.messages.at(-1)!;
const buttons = (e: Env) => (lastPrompt(e).components as Array<{ components: Array<{ custom_id: string; label: string; style: number }> }>)[0]!.components;
const reply = (e: Env, i = -1) => e.rest.interactionResponses.at(i)!.body as { type: number; data?: { content?: string; flags?: number; components?: unknown } };

const CHOICES = [
  { id: "once", label: "Allow once" },
  { id: "deny", label: "Deny" },
];

async function setup(opts: { ttlMs?: number; approverIds?: string[] } = {}) {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  const decisions: ApprovalDecision[] = [];
  ch.onDecision((d) => void decisions.push(d));
  const { promptId, refs } = await ch.prompt({
    chatId: GUILD_CHANNEL,
    text: "Run `rm -rf build`?",
    choices: CHOICES,
    approverIds: opts.approverIds ?? [GROUP_USER],
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  return { e, ch, decisions, promptId, refs };
}

test("D109: prompt renders one button per choice with opaque, bounded custom ids", async () => {
  const { e, promptId, refs } = await setup();
  assert.equal(refs.length, 1);
  const rows = buttons(e);
  assert.equal(rows.length, 2);
  for (const b of rows) {
    assert.ok(b.custom_id.length <= 100);
    assert.ok(!b.custom_id.includes(promptId), "promptId is not on the wire in clear");
    assert.ok(!/once|deny/.test(b.custom_id), "choice ids are not on the wire in clear");
  }
  assert.deepEqual(rows.map((b) => b.label), ["Allow once", "Deny"]);
  assert.equal(rows[1]!.style, 4, "deny is styled as danger");
  assert.equal(lastPrompt(e).content, "Run `rm -rf build`?");
  assert.deepEqual(lastPrompt(e).allowedMentions, { parse: [] });
  await e.current!.stop();
  await e.close();
});

test("D109: the approver's press emits exactly one decision and disables the buttons", async () => {
  const { e, ch, decisions, promptId } = await setup();
  await press(e, buttons(e)[0]!.custom_id);
  assert.equal(decisions.length, 1);
  assert.deepEqual(
    { promptId: decisions[0]!.promptId, chatId: decisions[0]!.chatId, senderId: decisions[0]!.senderId, choiceId: decisions[0]!.choiceId },
    { promptId, chatId: GUILD_CHANNEL, senderId: GROUP_USER, choiceId: "once" },
  );
  const r = reply(e);
  assert.equal(r.type, 7, "the message is updated in place");
  assert.ok(r.data!.content!.includes(MESSAGES.en.decided("Allow once")));
  const disabled = (r.data!.components as Array<{ components: Array<{ disabled: boolean }> }>)[0]!.components;
  assert.ok(disabled.every((b) => b.disabled === true));
  await ch.stop();
  await e.close();
});

interface Refusal {
  name: string;
  run(e: Env, promptId: string, decisions: ApprovalDecision[]): Promise<void>;
  expect: "forbidden" | "invalid" | "not-here";
}
const refusals: Refusal[] = [
  {
    name: "a non-approver presses a valid button",
    run: async (e) => press(e, buttons(e)[0]!.custom_id, { user: OTHER_USER }),
    expect: "forbidden",
  },
  {
    name: "a forged (tampered) handle",
    run: async (e) => {
      const wire = buttons(e)[0]!.custom_id;
      await press(e, wire.slice(0, -1) + (wire.endsWith("A") ? "B" : "A"));
    },
    expect: "invalid",
  },
  {
    name: "a garbage handle",
    run: async (e) => press(e, "not-a-handle"),
    expect: "invalid",
  },
  {
    name: "a press from a channel that is not allowed",
    run: async (e) => press(e, buttons(e)[0]!.custom_id, { channel: NOT_ALLOWED_CHANNEL }),
    expect: "not-here",
  },
];
for (const row of refusals)
  test(`D109 refusal: ${row.name} is answered politely and never emits a decision`, async () => {
    const { e, ch, decisions, promptId } = await setup();
    await row.run(e, promptId, decisions);
    assert.equal(decisions.length, 0);
    const r = reply(e);
    assert.equal(r.type, 4, "ephemeral reply");
    assert.equal(r.data!.flags, 64);
    const expected = row.expect === "forbidden" ? MESSAGES.en.buttonForbidden : row.expect === "not-here" ? MESSAGES.en.notHere : MESSAGES.en.buttonInvalid;
    assert.equal(r.data!.content, expected);
    await ch.stop();
    await e.close();
  });

test("D109: a refused non-approver press does not burn the handle for the real approver", async () => {
  const { e, ch, decisions } = await setup({ approverIds: [GROUP_USER, OTHER_USER] });
  const wire = buttons(e)[1]!.custom_id;
  await press(e, wire, { user: "123123123123123123" });
  assert.equal(decisions.length, 0);
  await press(e, wire, { user: OTHER_USER });
  assert.equal(decisions.length, 1);
  await ch.stop();
  await e.close();
});

test("D109: replay after a decision is refused, and sibling buttons are dead too", async () => {
  const { e, ch, decisions } = await setup();
  const [once, deny] = buttons(e).map((b) => b.custom_id);
  await press(e, once!);
  await press(e, once!);
  await press(e, deny!);
  assert.equal(decisions.length, 1);
  assert.equal(reply(e).data!.content, MESSAGES.en.buttonInvalid);
  await ch.stop();
  await e.close();
});

test("D109: a failed UI edit after a valid press still emits the decision once", async () => {
  const { e, ch, decisions } = await setup();
  e.rest.fail("POST /api/v10/interactions/", { status: 403, body: { message: "Unknown interaction", code: 10062 } });
  await press(e, buttons(e)[0]!.custom_id);
  assert.equal(decisions.length, 1, "the valid press is not lost");
  assert.ok(e.logs.some((l) => l.event === "channel.discord.button-ui-failed"));
  await ch.stop();
  await e.close();
});

test("D109: an expired prompt refuses even the right approver", async () => {
  const { e, ch, decisions } = await setup({ ttlMs: 1000 });
  const wire = buttons(e)[0]!.custom_id;
  await e.clock.advance(1001);
  await press(e, wire);
  assert.equal(decisions.length, 0);
  assert.equal(reply(e).data!.content, MESSAGES.en.buttonInvalid);
  await ch.stop();
  await e.close();
});

test("D109: prompt input is validated (TTL cap, approvers, choices, labels)", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  const base = { chatId: GUILD_CHANNEL, text: "t", choices: CHOICES, approverIds: [GROUP_USER] };
  await assert.rejects(ch.prompt({ ...base, ttlMs: 86_400_001 }), RangeError);
  await assert.rejects(ch.prompt({ ...base, ttlMs: 0 }), RangeError);
  await assert.rejects(ch.prompt({ ...base, approverIds: [] }), RangeError);
  await assert.rejects(ch.prompt({ ...base, approverIds: ["not-an-id"] }), RangeError);
  await assert.rejects(ch.prompt({ ...base, choices: [] }), RangeError);
  await assert.rejects(ch.prompt({ ...base, choices: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: "x" })) }), RangeError);
  await assert.rejects(ch.prompt({ ...base, choices: [{ id: "Bad Id", label: "x" }] }), RangeError);
  await assert.rejects(ch.prompt({ ...base, choices: [{ id: "a", label: "x".repeat(81) }] }), RangeError);
  await assert.rejects(ch.prompt({ ...base, choices: [{ id: "a", label: "x" }, { id: "a", label: "y" }] }), RangeError);
  await assert.rejects(ch.prompt({ ...base, chatId: NOT_ALLOWED_CHANNEL }), /allowlist/);
  assert.equal(e.rest.messages.length, 0);
  await ch.stop();
  await e.close();
});

test("D109: two prompts are independent; each handle set works only for its own prompt", async () => {
  const { e, ch, decisions } = await setup();
  const first = buttons(e)[0]!.custom_id;
  const second = await ch.prompt({ chatId: GUILD_CHANNEL, text: "again", choices: CHOICES, approverIds: [GROUP_USER] });
  assert.notEqual(second.promptId, undefined);
  const secondWire = buttons(e)[0]!.custom_id;
  assert.notEqual(secondWire, first);
  await press(e, secondWire);
  await press(e, first);
  assert.equal(decisions.length, 2);
  await ch.stop();
  await e.close();
});

test("/status answers ephemerally with the health text", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await command(e, "status", { user: OTHER_USER });
  assert.equal(reply(e).type, 4);
  assert.equal(reply(e).data!.content, MESSAGES.en.statusOnline);
  assert.equal(reply(e).data!.flags, 64);
  await ch.stop();
  await e.close();
});

test("/status is available in German when the locale is de", async () => {
  const e = await makeEnv({ locale: "de" });
  const ch = e.channel();
  await started(e, ch);
  await command(e, "status");
  assert.equal(reply(e).data!.content, MESSAGES.de.statusOnline);
  await ch.stop();
  await e.close();
});

test("/link in a DM claims the pairing with the bot id as accountId and replies uniformly", async () => {
  const claims: unknown[] = [];
  const e = await makeEnv();
  const ch = e.channel({}, { pairing: { claim: (p: unknown) => (claims.push(p), { pairingId: "p", state: "awaiting-confirmation", confirmBy: 1 }) } as never });
  await started(e, ch);
  await command(e, "link", { options: [{ name: "code", type: 3, value: "ABCD-1234" }] });
  assert.deepEqual(claims, [{ code: "ABCD-1234", identity: { channel: "discord", accountId: BOT_ID, userId: DM_USER } }]);
  assert.equal(reply(e).data!.content, MESSAGES.en.pairOk("p"));
  assert.equal(reply(e).data!.flags, 64);
  assert.ok(!JSON.stringify(e.rest.interactionResponses).includes("ABCD-1234"), "the code is never echoed");
  assert.ok(!JSON.stringify(e.logs).includes("ABCD-1234"), "the code is never logged");
  await ch.stop();
  await e.close();
});

const linkFailures: Array<[string, { options?: { name: string; type: number; value: string }[]; guild?: boolean }, boolean]> = [
  ["a guild channel (DM only)", { options: [{ name: "code", type: 3, value: "CODE-0001" }], guild: true }, false],
  ["an empty code", { options: [{ name: "code", type: 3, value: "" }] }, false],
  ["a missing code option", {}, false],
  ["a code longer than 128 characters", { options: [{ name: "code", type: 3, value: "x".repeat(129) }] }, false],
];
for (const [name, opts] of linkFailures)
  test(`/link refuses ${name} without calling the identity port`, async () => {
    let calls = 0;
    const e = await makeEnv();
    const ch = e.channel({}, { pairing: { claim: () => (calls++, { pairingId: "p", state: "awaiting-confirmation", confirmBy: 1 }) } as never });
    await started(e, ch);
    await command(e, "link", opts);
    assert.equal(calls, 0);
    assert.equal(reply(e).data!.content, opts.guild ? MESSAGES.en.notHere : MESSAGES.en.pairFail);
    await ch.stop();
    await e.close();
  });

test("/link: a claim failure gets the same uniform message and no detail", async () => {
  const e = await makeEnv();
  const ch = e.channel({}, { pairing: { claim: () => { throw new Error("unknown code CODE-9999 for human h1"); } } as never });
  await started(e, ch);
  await command(e, "link", { options: [{ name: "code", type: 3, value: "CODE-9999" }] });
  assert.equal(reply(e).data!.content, MESSAGES.en.pairFail);
  assert.ok(!JSON.stringify(e.rest.interactionResponses).includes("CODE-9999"));
  assert.ok(!JSON.stringify(e.logs).includes("CODE-9999"));
  await ch.stop();
  await e.close();
});

test("/link without a pairing port is refused (and not advertised)", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await command(e, "link", { options: [{ name: "code", type: 3, value: "CODE-1" }] });
  assert.equal(reply(e).data!.content, MESSAGES.en.pairFail);
  await ch.stop();
  await e.close();
});

test("slow /link is deferred inside the 3 s deadline and answered by editing the original response", async () => {
  let resolveClaim!: () => void;
  const pending = new Promise<{ pairingId: string; state: "awaiting-confirmation"; confirmBy: number }>((r) => {
    resolveClaim = () => r({ pairingId: "p", state: "awaiting-confirmation", confirmBy: 0 });
  });
  const e = await makeEnv();
  const ch = e.channel({}, { pairing: { claim: () => pending } as never });
  await started(e, ch);
  await e.gateway.whenReady();
  interact(e, { type: 2, channel_id: DM_CHANNEL, user: { id: DM_USER }, data: { name: "link", type: 1, options: [{ name: "code", type: 3, value: "SLOW-1" }] } });
  const idle = e.current!.idle();
  for (let i = 0; i < 20; i++) await e.clock.flush();
  assert.equal(e.rest.interactionResponses.length, 0, "no answer before the deadline");
  await e.clock.advance(2500);
  for (let i = 0; i < 400 && e.rest.interactionResponses.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(reply(e, 0).type, 5, "deferred ephemeral acknowledgement");
  assert.equal(reply(e, 0).data!.flags, 64);
  resolveClaim();
  await idle;
  assert.equal(e.rest.webhookPatches.length, 1);
  assert.equal((e.rest.webhookPatches[0]!.body as { content: string }).content, MESSAGES.en.pairOk("p"));
  assert.ok(!JSON.stringify(e.rest.webhookPatches).includes("SLOW-1"));
  await ch.stop();
  await e.close();
});

test("interactions from bot accounts and unknown commands are ignored", async () => {
  const e = await makeEnv();
  const ch = e.channel();
  await started(e, ch);
  await command(e, "status", { bot: true });
  await command(e, "does-not-exist");
  assert.equal(e.rest.interactionResponses.length, 0);
  await ch.stop();
  await e.close();
});

test("the bot token never appears in interaction responses or logs", async () => {
  const { e, ch } = await setup();
  await press(e, buttons(e)[0]!.custom_id);
  await command(e, "status");
  assert.ok(!JSON.stringify([e.rest.interactionResponses, e.logs, e.rest.messages]).includes(TOKEN));
  await ch.stop();
  await e.close();
});
