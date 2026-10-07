// Chat page (E6): history, transcript, streaming over SSE, cancel, new chat, errors, layout, a11y, keyboard. Runs against
// the mock /rpc and /events (test/chat-fixtures.ts); the backend does not exist yet, the contract is docs/rpc.md.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { withChat, type FakeChat } from "./chat-fixtures.ts";
import { browserSkip, setup, teardown } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const history = (c: FakeChat): void => { c.seed({ id: "ses_1", title: "Hello world", messages: [["user", "Earlier question"], ["assistant", "Earlier answer"]] }); };
const two = (c: FakeChat): void => { history(c); c.seed({ id: "ses_2", title: "Second chat", memoryMode: "incognito", agentId: "mara" }); };
const logOf = (page: Page) => page.getByRole("log", { name: "Conversation with bernd" });
const boxOf = (page: Page) => page.getByRole("textbox", { name: "Message to bernd" });
const calls = (c: FakeChat, method: string) => c.server.rpc.calls.filter((x) => x.method === method);
const logBusy = (page: Page, want: "true" | "false") => page.waitForFunction((w) => document.querySelector("[role=log]")?.getAttribute("aria-busy") === w, want);

describe("chat: success and streaming", opts, () => {
  test("history, then a message streams into the transcript live and the turn ends", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat, problems }) => {
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      const log = logOf(page);
      await log.getByText("Earlier answer").waitFor();
      assert.equal(await log.getAttribute("aria-live"), "polite");
      const row = page.getByRole("link", { name: /Hello world/ });
      assert.equal(await row.getAttribute("aria-current"), "page");

      const box = boxOf(page);
      await box.fill("Say hi");
      await box.press("Enter");
      await log.getByText("Say hi", { exact: true }).waitFor();
      assert.equal(await box.inputValue(), "");
      assert.deepEqual(calls(chat, "session.submit").map((c) => c.params), [{ sessionId: "ses_1", text: "Say hi" }]);
      assert.notEqual(calls(chat, "session.submit")[0]?.csrf, null, "a write carries a CSRF token");

      await log.getByText("Writing…").waitFor();
      await logBusy(page, "true");
      chat.delta("ses_1", "Hel");
      await log.getByText("Hel", { exact: true }).waitFor();
      chat.delta("ses_1", "lo");
      await log.getByText("Hello", { exact: true }).waitFor();
      assert.equal(await log.getAttribute("aria-busy"), "true", "a running reply is collected, not announced delta by delta");
      chat.complete("ses_1");
      await log.getByText("Done").waitFor();
      await logBusy(page, "false");
      assert.equal(await page.getByRole("button", { name: "Stop" }).count(), 0);
      assert.deepEqual(problems, []);
    });
  });

  test("a reply is plain text: markup is shown literally, line breaks kept", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat }) => {
      const log = logOf(page);
      await log.waitFor();
      await boxOf(page).fill("x");
      await boxOf(page).press("Enter");
      await log.getByText("Writing…").waitFor();
      chat.delta("ses_1", "**bold** <b>tag</b>\nline2");
      chat.complete("ses_1");
      const text = log.locator(".msg-text", { hasText: "**bold**" });
      await text.waitFor();
      assert.equal(await text.evaluate((e) => (e as HTMLElement).innerText), "**bold** <b>tag</b>\nline2");
      assert.equal(await text.locator("b").count(), 0);
      assert.equal(await text.evaluate((e) => getComputedStyle(e).whiteSpace), "pre-wrap");
    });
  });

  test("a turn that is already running on load is picked up with its partial reply", async () => {
    await withChat({
      route: "#/chat/ses_1",
      seed: (c) => {
        history(c);
        c.running.set("ses_1", "t_run");
        c.emit("ses_1", "turn.started", { turnId: "t_run" }, { turnId: "t_run", push: false });
        c.delta("ses_1", "Part", { push: false });
      },
    }, async ({ page, chat }) => {
      const log = logOf(page);
      await log.getByText("Part", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Stop" }).waitFor();
      chat.delta("ses_1", "ial");
      await log.getByText("Partial", { exact: true }).waitFor();
    });
  });

  test("without /events the reply is fetched by polling session.events and a note says so", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history, noEvents: true }, async ({ page, chat }) => {
      const log = logOf(page);
      await boxOf(page).fill("poll me");
      await boxOf(page).press("Enter");
      await log.getByText("Writing…").waitFor();
      await page.getByText("Live updates are not available").waitFor();
      chat.delta("ses_1", "polled");
      await log.getByText("polled", { exact: true }).waitFor();
      chat.complete("ses_1");
      await log.getByText("Done").waitFor();
    });
  });
});

describe("chat: empty, errors, states", opts, () => {
  test("no sessions: empty state with the new-chat panel, axe clean", async () => {
    await withChat({}, async ({ page }) => {
      await page.getByRole("heading", { name: "No chats yet", level: 2 }).waitFor();
      await page.getByRole("heading", { name: "Talk to an agent", level: 2 }).waitFor();
      await page.getByRole("combobox", { name: "Agent" }).waitFor();
      await expectAxeClean(page, "chat empty");
    });
  });

  test("session.list failing: error state, Try again reloads", async () => {
    await withChat({ seed: (c) => { history(c); c.server.rpc.scenario("session.list", "error", { code: "E_INTERNAL", message: "boom" }); } }, async ({ page, chat }) => {
      const alert = page.getByRole("alert");
      await alert.getByRole("heading", { name: "Something went wrong" }).waitFor();
      await expectAxeClean(page, "chat error");
      chat.server.rpc.scenario("session.list", "success");
      await alert.getByRole("button", { name: "Try again" }).click();
      await page.getByRole("link", { name: /Hello world/ }).waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
    });
  });

  test("forbidden", async () => {
    await withChat({ seed: (c) => { c.server.rpc.scenario("session.list", "forbidden"); } }, async ({ page }) => {
      await page.getByRole("heading", { name: "Not allowed", level: 2 }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0);
    });
  });

  test("unavailable: the backend has no /rpc (404)", async () => {
    await withChat({ noRpc: true }, async ({ page, problems }) => {
      await page.getByRole("heading", { name: "Chat is not available", level: 2 }).waitFor();
      await page.getByText("no chat service").waitFor();
      assert.deepEqual(problems, []);
    });
  });

  test("an unknown session id is a clear not-found, not a blank pane", async () => {
    await withChat({ route: "#/chat/ses_nope", seed: history }, async ({ page }) => {
      await page.getByRole("heading", { name: "Chat not found", level: 2 }).waitFor();
      await page.getByRole("link", { name: /Hello world/ }).waitFor();
    });
  });

  test("submit refused: no provider, and a turn already running, as readable hints; the text stays in the box", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat }) => {
      await logOf(page).waitFor();
      const box = boxOf(page);
      chat.submitFailure = { code: "E_NOT_AVAILABLE", message: "no provider", reason: "no-provider" };
      await box.fill("hello?");
      await box.press("Enter");
      await page.getByRole("alert").filter({ hasText: "No model provider is configured" }).waitFor();
      assert.equal(await box.inputValue(), "hello?");
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
      await expectAxeClean(page, "chat submit error");

      chat.submitFailure = { code: "E_CONFLICT", message: "running", reason: "turn-in-progress" };
      await box.press("Enter");
      await page.getByRole("alert").filter({ hasText: "still answering" }).waitFor();
      assert.equal(await box.inputValue(), "hello?");
    });
  });
});

describe("chat: reconnect and catch-up", opts, () => {
  test("the stream drops mid-reply: it reconnects, missing events are fetched, nothing is shown twice", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat }) => {
      const log = logOf(page);
      await log.waitFor();
      await chat.server.events.waitForConnections(1);
      await boxOf(page).fill("go");
      await boxOf(page).press("Enter");
      await log.getByText("Writing…").waitFor();
      chat.delta("ses_1", "A");
      await log.getByText("A", { exact: true }).waitFor();

      chat.server.events.dropConnections();
      chat.delta("ses_1", "B"); // pushed while nobody listens: the mock replays it on reconnect (Last-Event-ID) ...
      chat.delta("ses_1", "C", { push: false }); // ... this one only exists in session.events
      await chat.server.events.waitForConnections(2);
      await log.getByText("ABC", { exact: true }).waitFor();

      chat.delta("ses_1", "D");
      await log.getByText("ABCD", { exact: true }).waitFor();
      chat.complete("ses_1");
      await log.getByText("Done").waitFor();
      assert.equal(await log.locator(".msg-text", { hasText: "ABCD" }).count(), 1);
      assert.equal(await log.locator("[data-role=assistant]").count(), 2, "history answer + this reply, no duplicate entry");
      const reconnect = chat.server.events.connections[1];
      assert.notEqual(reconnect?.lastEventId, null, "the client resumed with Last-Event-ID");
      assert.ok(calls(chat, "session.events").some((c) => (c.params as { afterSeq?: number }).afterSeq !== undefined), "catch-up asked session.events afterSeq");
    });
  });

  test("a skipped seq (gap) triggers a catch-up instead of dropping text", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat }) => {
      const log = logOf(page);
      await chat.server.events.waitForConnections(1);
      await boxOf(page).fill("go");
      await boxOf(page).press("Enter");
      await log.getByText("Writing…").waitFor();
      chat.delta("ses_1", "one ", { push: false });
      chat.delta("ses_1", "two");
      await log.getByText("one two", { exact: true }).waitFor();
    });
  });
});

describe("chat: cancel", opts, () => {
  test("Stop cancels the running turn; it ends as stopped and the box has focus again", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat }) => {
      const log = logOf(page);
      await boxOf(page).fill("long one");
      await boxOf(page).press("Enter");
      await log.getByText("Writing…").waitFor();
      chat.delta("ses_1", "half");
      await log.getByText("half", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Stop" }).click();
      await log.getByText("Stopped").waitFor();
      assert.deepEqual(calls(chat, "session.cancel").map((c) => c.params), [{ sessionId: "ses_1" }]);
      assert.equal(await page.getByRole("button", { name: "Stop" }).count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
      await log.getByText("half", { exact: true }).waitFor();
      await logBusy(page, "false");
    });
  });
});

describe("chat: new chat", opts, () => {
  test("agent, incognito switch and first message create a session, submit, and open it", async () => {
    await withChat({ seed: history }, async ({ page, chat }) => {
      await page.getByRole("link", { name: /Hello world/ }).waitFor();
      await page.getByRole("combobox", { name: "Agent" }).selectOption("mara");
      await page.getByRole("checkbox", { name: "Don't remember this chat" }).check();
      await page.getByRole("textbox", { name: "First message" }).fill("Hi Mara");
      await page.getByRole("button", { name: "Start chat" }).click();
      await page.waitForFunction(() => /^#\/chat\/auto_/.test(location.hash));
      const created = calls(chat, "session.create")[0]?.params;
      assert.deepEqual(created, { agentId: "mara", kind: "direct", memoryMode: "incognito" });
      const sid = chat.sessions.at(-1)?.id ?? "";
      assert.deepEqual(calls(chat, "session.submit").map((c) => c.params), [{ sessionId: sid, text: "Hi Mara" }]);
      const log = page.getByRole("log", { name: "Conversation with mara" });
      await log.getByText("Hi Mara", { exact: true }).waitFor();
      await page.getByText("Not remembered").first().waitFor();
      chat.delta(sid, "Hello!");
      await log.getByText("Hello!", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "focus lands in the composer");
    });
  });

  test("by default the chat is remembered (memoryMode remember)", async () => {
    await withChat({ route: "#/chat/new" }, async ({ page, chat }) => {
      await page.getByRole("textbox", { name: "First message" }).fill("plain");
      await page.getByRole("button", { name: "Start chat" }).click();
      await page.getByRole("log").waitFor();
      assert.deepEqual(calls(chat, "session.create")[0]?.params, { agentId: "bernd", kind: "direct", memoryMode: "remember" });
    });
  });

  test("no agent known: the panel says so and Start chat is disabled", async () => {
    await withChat({ agents: [] }, async ({ page }) => {
      await page.getByText("No agent is available to chat with.").waitFor();
      assert.equal(await page.getByRole("button", { name: "Start chat" }).getAttribute("aria-disabled"), "true");
    });
  });
});

describe("chat: layout", opts, () => {
  test("normal (1440): history and transcript side by side, transcript at most 820 px", async () => {
    await withChat({ route: "#/chat/ses_1", seed: two, width: 1440 }, async ({ page }) => {
      const log = logOf(page);
      await log.waitFor();
      const list = page.getByRole("region", { name: "Chat history" });
      assert.ok(await list.isVisible());
      const lb = (await list.boundingBox())!;
      const tb = (await page.locator(".chat-pane").boundingBox())!;
      assert.ok(lb.x + lb.width <= tb.x + 1, "list left of transcript");
      assert.ok(tb.width <= 820.5, `transcript ${tb.width}px`);
      assert.ok(await page.getByRole("link", { name: /Second chat/ }).isVisible());
      assert.ok(await list.getByText("Not remembered").isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
  });

  test("compact (400): list first, a chat pushes the transcript, Back returns; targets >= 44 px; no sideways scroll", async () => {
    await withChat({ route: "#/chat", seed: two, width: 400, height: 800 }, async ({ page }) => {
      const list = page.getByRole("region", { name: "Chat history" });
      const row = page.getByRole("link", { name: /Hello world/ });
      await row.waitFor();
      assert.equal(await page.locator(".ld-detail").isVisible(), false);
      assert.ok((await row.boundingBox())!.height >= 44);
      await row.click();
      await logOf(page).waitFor();
      assert.equal(await list.isVisible(), false);
      assert.ok((await page.getByRole("button", { name: "Send" }).boundingBox())!.height >= 44);
      assert.ok((await boxOf(page).boundingBox())!.width <= 400);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole("button", { name: "Back to list" }).click();
      await list.waitFor();
      assert.equal(await page.evaluate(() => location.hash), "#/chat");
    });
  });

  test("compact: the empty state and the new-chat link", async () => {
    await withChat({ width: 400, height: 800 }, async ({ page }) => {
      await page.getByRole("heading", { name: "No chats yet" }).waitFor();
      await page.getByRole("link", { name: "New chat" }).click();
      await page.getByRole("heading", { name: "Talk to an agent" }).waitFor();
      assert.equal(await page.evaluate(() => location.hash), "#/chat/new");
    });
  });
});

describe("chat: accessibility", opts, () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 400]] as const) {
    test(`transcript, running and finished: axe clean (${scheme}, ${width} px)`, async () => {
      await withChat({ route: "#/chat/ses_1", seed: two, colorScheme: scheme, width, height: 800 }, async ({ page, chat }) => {
        const log = logOf(page);
        await log.getByText("Earlier answer").waitFor();
        await expectAxeClean(page, "transcript");
        await boxOf(page).fill("go");
        await boxOf(page).press("Enter");
        await log.getByText("Writing…").waitFor();
        chat.delta("ses_1", "streaming");
        await log.getByText("streaming", { exact: true }).waitFor();
        await expectAxeClean(page, "transcript running");
        chat.complete("ses_1");
        await log.getByText("Done").waitFor();
        await expectAxeClean(page, "transcript done");
      });
    });
  }

  test("a failed turn and the live-region contract: log is polite, additions only, sr-only status separate", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat }) => {
      const log = logOf(page);
      await boxOf(page).fill("go");
      await boxOf(page).press("Enter");
      await log.getByText("Writing…").waitFor();
      chat.emit("ses_1", "turn.failed", { error: "provider exploded" });
      chat.running.delete("ses_1");
      await log.getByText("Failed").waitFor();
      await log.getByText("provider exploded").waitFor();
      assert.equal(await log.getAttribute("aria-live"), "polite");
      assert.equal(await log.getAttribute("aria-relevant"), "additions");
      assert.equal(await page.getByRole("status").filter({ hasText: "reply failed" }).count(), 1);
      await expectAxeClean(page, "failed turn");
    });
  });

  test("keyboard: type, Shift+Enter breaks the line, Enter sends, focus stays in the box, Tab reaches Send", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat }) => {
      await logOf(page).waitFor();
      const box = boxOf(page);
      await box.focus();
      await page.keyboard.type("line1");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("line2");
      assert.equal(await box.inputValue(), "line1\nline2");
      assert.equal(calls(chat, "session.submit").length, 0);
      await page.keyboard.press("Enter");
      await logOf(page).getByText("Writing…").waitFor();
      assert.deepEqual(calls(chat, "session.submit").map((c) => (c.params as { text: string }).text), ["line1\nline2"]);
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
      await page.keyboard.press("Enter"); // empty box, running turn: nothing is sent
      assert.equal(calls(chat, "session.submit").length, 1);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Stop");
    });
  });

  test("the Send button is a real button and sends with the keyboard", async () => {
    await withChat({ route: "#/chat/ses_1", seed: history }, async ({ page, chat }) => {
      await logOf(page).waitFor();
      await boxOf(page).fill("via button");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Send");
      await page.keyboard.press("Enter");
      await logOf(page).getByText("via button", { exact: true }).waitFor();
      assert.equal(calls(chat, "session.submit").length, 1);
    });
  });
});

describe("chat: German", opts, () => {
  test("empty state, new chat and composer in German", async () => {
    await withChat({ locale: "de-DE", seed: history, route: "#/chat/ses_1" }, async ({ page }) => {
      await page.getByRole("link", { name: "Neuer Chat" }).waitFor();
      await page.getByRole("textbox", { name: "Nachricht an bernd" }).waitFor();
      await page.getByRole("button", { name: "Senden" }).waitFor();
      await page.getByRole("log", { name: "Unterhaltung mit bernd" }).waitFor();
    });
  });
});
