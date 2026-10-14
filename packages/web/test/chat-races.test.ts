// Chat double sends (audit b19): Enter and the Send button fired in the same task (a held key plus a click, assistive tech,
// automation) must send once. The UI guard (`ready`) only updates after a re-render, so the handlers need their own.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { withChat } from "./chat-fixtures.ts";
import { browserSkip, setup, teardown } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("chat: double dispatch", opts, () => {
  test("Enter + Send click in one task send one message and leave the composer empty", async () => {
    await withChat({ route: "#/chat/ses_1", seed: (c) => { c.seed({ id: "ses_1", title: "T" }); } }, async ({ page, chat }) => {
      chat.server.rpc.setDelay("session.submit", 300);
      const box = page.getByRole("textbox", { name: "Message to bernd" });
      await box.fill("once");
      await page.evaluate(() => {
        const ta = document.querySelector("textarea") as HTMLTextAreaElement;
        const send = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Send") as HTMLButtonElement;
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        send.click();
      });
      await page.getByText("once", { exact: true }).first().waitFor();
      await page.waitForTimeout(700);
      assert.equal(chat.server.rpc.calls.filter((c) => c.method === "session.submit").length, 1);
      assert.equal(await box.inputValue(), "", "the draft is not put back after a successful send");
    });
  });

  test("new chat: Enter + Start click in one task create one session", async () => {
    await withChat({ route: "#/chat/new" }, async ({ page, chat }) => {
      chat.server.rpc.setDelay("session.create", 300);
      const box = page.getByRole("textbox", { name: "First message" });
      await box.fill("hello");
      await page.evaluate(() => {
        const ta = document.querySelector("textarea") as HTMLTextAreaElement;
        const start = Array.from(document.querySelectorAll("button")).find((b) => b.classList.contains("btn-primary") && b.closest(".chat-compose")) as HTMLButtonElement;
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        start.click();
      });
      await page.waitForURL(/#\/chat\/auto_/);
      await page.waitForTimeout(700);
      assert.equal(chat.server.rpc.calls.filter((c) => c.method === "session.create").length, 1);
      assert.equal(chat.server.rpc.calls.filter((c) => c.method === "session.submit").length, 1);
    });
  });
});
