import assert from "node:assert/strict";
import { test } from "node:test";
import { SYNC_FILTER, formatChatId, mentionsBot, parseChatId, replyTarget, stripReplyFallback, threadRoot } from "../src/events.ts";
import { resolveConfig, type MatrixConfig } from "../src/config.ts";
import { ALICE, BOT, ROOM } from "./helpers/fake-matrix.ts";

const base: MatrixConfig = {
  homeserverUrl: "https://hs.example.org",
  userId: BOT,
  accessTokenSecret: "matrix/bot-token",
  allowlist: [ROOM],
  dmAllowlist: [ALICE],
};

test("config: defaults and accepted shapes", () => {
  const r = resolveConfig(base);
  assert.equal(r.autoJoin, "allowlist");
  assert.equal(r.replyPolicy, "mention");
  assert.equal(r.locale, "en");
  assert.equal(r.maxMediaBytes, 10 * 1024 * 1024);
});

const badConfigs: [string, Partial<MatrixConfig>][] = [
  ["bad userId", { userId: "bot" }],
  ["room id in dmAllowlist position", { dmAllowlist: [ROOM] }],
  ["mxid in allowlist position", { allowlist: [ALICE] }],
  ["allowlist policy without userAllowlist", { replyPolicy: "allowlist" }],
  ["maxMediaBytes above hard max", { maxMediaBytes: 26 * 1024 * 1024 }],
  ["maxMediaBytes zero", { maxMediaBytes: 0 }],
  ["unknown autoJoin", { autoJoin: "always" as never }],
  ["unknown locale", { locale: "fr" as never }],
  ["token given as a value, not a secret name", { accessTokenSecret: "syt_abc def" }],
  ["bad deviceId", { deviceId: "has space" }],
];
for (const [name, over] of badConfigs) test(`config refused: ${name}`, () => assert.throws(() => resolveConfig({ ...base, ...over }), RangeError));

test("config: allowlist policy with a userAllowlist is accepted", () => {
  assert.doesNotThrow(() => resolveConfig({ ...base, replyPolicy: "allowlist", userAllowlist: [ALICE] }));
});

test("sync filter limits event types to what the channel reads", () => {
  const f = JSON.parse(SYNC_FILTER);
  assert.deepEqual(f.room.timeline.types, ["m.room.message", "m.reaction", "m.room.encrypted"]);
  assert.deepEqual(f.account_data.types, ["m.direct"]);
});

test("chat ids: room ids contain colons; thread suffix is split at the last ':$'", () => {
  assert.deepEqual(parseChatId(ROOM), { roomId: ROOM });
  assert.deepEqual(parseChatId(`${ROOM}:$abc`), { roomId: ROOM, thread: "$abc" });
  assert.equal(formatChatId(ROOM, "$abc"), `${ROOM}:$abc`);
  for (const bad of ["room", "!x:y:$", "!x:y:$a b"]) assert.throws(() => parseChatId(bad), /invalid/, bad);
});

test("mentions: m.mentions is authoritative when present; the body fallback only without it", () => {
  const who = { userId: BOT, displayName: "Bot Display" };
  assert.equal(mentionsBot({ "m.mentions": { user_ids: [BOT] } }, "x", who), true);
  assert.equal(mentionsBot({ "m.mentions": { user_ids: [] } }, `${BOT} hi`, who), false);
  assert.equal(mentionsBot({}, `ping ${BOT}`, who), true);
  assert.equal(mentionsBot({}, "ping @bot", who), true);
  assert.equal(mentionsBot({}, "ping @bot2", who), false);
  assert.equal(mentionsBot({}, "ping bot display now", who), true);
  assert.equal(mentionsBot({}, "xbot", who), false);
});

test("reply and thread relations: a thread fallback is not a reply", () => {
  assert.equal(replyTarget({ "m.relates_to": { "m.in_reply_to": { event_id: "$r" } } }), "$r");
  assert.equal(replyTarget({ "m.relates_to": { rel_type: "m.thread", event_id: "$t", is_falling_back: true, "m.in_reply_to": { event_id: "$t" } } }), undefined);
  assert.equal(threadRoot({ "m.relates_to": { rel_type: "m.thread", event_id: "$t" } }), "$t");
  assert.equal(threadRoot({}), undefined);
});

test("reply fallback: stripped only with mx-reply HTML, leaving the reply text", () => {
  const body = "> <@carol:hs.test> old\n> more\n\nnew";
  assert.equal(stripReplyFallback(body, { formatted_body: "<mx-reply>x</mx-reply>new" }), "new");
  assert.equal(stripReplyFallback(body, {}), body);
  assert.equal(stripReplyFallback("> quoted\nnot a reply", { formatted_body: "<mx-reply>x</mx-reply>" }), "not a reply");
});
