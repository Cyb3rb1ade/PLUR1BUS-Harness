/** D120 CX1: rewind REST derives identity from authentication and accepts exactly one apply/undo action. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChatHandlers, CHAT_ROUTES } from "../src/chat-routes.ts";
import type { HandlerInput } from "../src/routes.ts";

test("chat rewind route supplies its path session and refuses identity or mixed undo/apply fields", async () => {
  const calls: unknown[] = [];
  const handlers = buildChatHandlers({ call: async <T>(method: string, params: unknown) => {
    calls.push({ method, params });
    return { sessionId: "ses_owned", rewind: { id: "rew_one", sessionId: "ses_owned", parentSeq: 2,
      hiddenFromSeq: 3, hiddenToSeq: 4, lessonMessageId: "msg_note", hiddenDigest: "a".repeat(64), trigger: "user",
      actor: "alice", createdAt: 1, undoneAt: null } } as T;
  } }, { emit() {} });
  const input = (body: object): HandlerInput => ({ body, principal: { kind: "user", id: "alice", role: "member" },
    pathParams: { sessionId: "ses_owned" }, headers: {} }) as unknown as HandlerInput;
  const route = CHAT_ROUTES.find(route => route.id === "chats.rewind");
  assert.equal(route?.csrf, true);
  assert.equal(route?.path, "/api/v1/chats/{sessionId}/rewind");
  await handlers["chats.rewind"]!(input({ toSeq: 2 }));
  await handlers["chats.rewind"]!(input({ undo: "rew_one" }));
  assert.deepEqual(calls, [{ method: "chat.rewind", params: { sessionId: "ses_owned", toSeq: 2 } },
    { method: "chat.rewind", params: { sessionId: "ses_owned", undo: "rew_one" } }]);
  for (const body of [{ toSeq: 2, caller: "forged" }, { toSeq: 2, actor: "other" }, { toSeq: 2, undo: "rew_one" },
    { undo: "rew_one", files: true }]) {
    await assert.rejects(async () => handlers["chats.rewind"]!(input(body)), (error: unknown) => (error as { status: number }).status === 400);
  }
  assert.equal(calls.length, 2);
});
