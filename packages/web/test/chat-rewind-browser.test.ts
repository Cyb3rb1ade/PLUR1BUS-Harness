/** D120 CX1: a human can rewind from a message, inspect preserved content and undo with the keyboard. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { withChat } from "./chat-fixtures.ts";
import { browserSkip, setup, teardown } from "./harness.ts";

before(setup);
after(teardown);

test("rewind to a message preserves the discarded transcript and undo restores its presentation", { skip: browserSkip }, async () => {
  await withChat({ route: "#/chat/rewind", seed: chat => {
    chat.seed({ id: "rewind", messages: [["user", "kept question"], ["assistant", "kept answer"],
      ["user", "discarded question"], ["assistant", "discarded answer"]] });
    const rewinds: Record<string, unknown>[] = [];
    chat.server.rpc.handle("session.rewind", raw => {
      const params = raw as { toSeq?: number; undo?: string };
      const messages = chat.messages.get("rewind")!;
      if (params.undo) {
        for (const message of messages) delete message.rewound;
        rewinds[0]!.undoneAt = 2;
      } else {
        for (const message of messages) if (message.seq > params.toSeq!) message.rewound = true;
        rewinds.push({ id: "rew_one", sessionId: "rewind", parentSeq: params.toSeq,
          hiddenFromSeq: 3, hiddenToSeq: 4, lessonMessageId: null, hiddenDigest: "a".repeat(64),
          trigger: "user", actor: "owner", createdAt: 1, undoneAt: null });
      }
      return { sessionId: "rewind", rewind: rewinds[0] };
    });
    chat.server.rpc.handle("session.resume", () => ({ session: chat.sessions[0],
      messages: chat.messages.get("rewind"), rewinds, runningTurnId: null, lastEventSeq: 0 }), { write: false });
  } }, async ({ page, chat, problems }) => {
    await page.getByRole("button", { name: "Rewind to message 2", exact: true }).click();
    await page.getByRole("button", { name: "Undo rewind", exact: true }).waitFor();
    const discarded = page.locator("details.msg-rewound");
    assert.equal(await discarded.count(), 2);
    assert.equal(await page.getByText("discarded answer", { exact: true }).isVisible(), false);
    await discarded.last().locator("summary").click();
    await page.getByText("discarded answer", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Undo rewind", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("details.msg-rewound").length === 0);
    assert.deepEqual(chat.server.rpc.calls.filter(call => call.method === "session.rewind").map(call => call.params),
      [{ sessionId: "rewind", toSeq: 2 }, { sessionId: "rewind", undo: "rew_one" }]);
    assert.deepEqual(problems, []);
  });
});

test("an interactive failure proposal changes the path only after one human confirmation", { skip: browserSkip }, async () => {
  await withChat({ route: "#/chat/proposal", seed: chat => {
    chat.seed({ id: "proposal", messages: [["user", "fix the check"], ["assistant", "the third check failed"]] });
    let pending = true;
    chat.server.rpc.handle("session.resume", () => ({ session: chat.sessions[0], messages: chat.messages.get("proposal"),
      rewinds: [], runningTurnId: null, lastEventSeq: 12,
      rewindProposal: pending ? { parentSeq: 0, failedCycles: 3, lastCheckSeq: 12, agentId: "main" } : null }), { write: false });
    chat.server.rpc.handle("session.rewind", () => { pending = false; return { sessionId: "proposal", rewind: {} }; });
  } }, async ({ page, chat, problems }) => {
    const confirm = page.getByRole("button", { name: "Confirm rewind", exact: true });
    await confirm.waitFor();
    assert.equal(chat.server.rpc.calls.filter(call => call.method === "session.rewind").length, 0);
    await confirm.click();
    await confirm.waitFor({ state: "hidden" });
    assert.deepEqual(chat.server.rpc.calls.filter(call => call.method === "session.rewind").map(call => call.params),
      [{ sessionId: "proposal", toSeq: 0 }]);
    assert.deepEqual(problems, []);
  });
});
