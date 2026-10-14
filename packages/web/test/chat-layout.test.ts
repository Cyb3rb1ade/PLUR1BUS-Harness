// Chat layout at the narrow desktop mode (<= 480 px) and at very wide windows (>= 1600 px): desktop spec G8, web part.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { withChat, type FakeChat } from "./chat-fixtures.ts";
import { browserSkip, setup, teardown } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const LONG = "word ".repeat(80);
const UNBROKEN = "x".repeat(300);
const seed = (c: FakeChat): void => {
  c.seed({ id: "ses_1", title: "Hello world", messages: [["user", `${LONG}${UNBROKEN}`], ["assistant", `${LONG}${UNBROKEN}\n    indented ${UNBROKEN}`]] });
  c.seed({ id: "ses_2", title: "Second chat", agentId: "mara" });
};
const noSideScroll = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

describe("chat layout: narrow (<= 480 px)", opts, () => {
  for (const width of [480, 360]) {
    test(`${width} px: no sideways scroll, composer and Send reachable inside the window, targets >= 24 px`, async () => {
      await withChat({ route: "#/chat/ses_1", seed, width, height: 700 }, async ({ page }) => {
        await page.getByRole("log").getByText("indented", { exact: false }).waitFor();
        assert.equal(await noSideScroll(page), true, "document scrolls sideways");
        const box = page.getByRole("textbox", { name: "Message to bernd" });
        const send = page.getByRole("button", { name: "Send" });
        await send.scrollIntoViewIfNeeded();
        for (const el of [box, send]) {
          const b = (await el.boundingBox())!;
          assert.ok(b.x >= 0 && b.x + b.width <= width, `${b.x}+${b.width} outside ${width}`);
        }
        assert.ok((await send.boundingBox())!.height >= 24);
        const small = await page.evaluate(() => Array.from(document.querySelectorAll("main a[href], main button, main select, main input, main textarea")).map((el) => ({ n: `${el.tagName}.${el.className}`, r: el.getBoundingClientRect() })).filter((x) => x.r.width > 2 && x.r.height > 2 && Math.min(x.r.width, x.r.height) < 24).map((x) => x.n));
        assert.deepEqual(small, [], "targets under 24 px");
        const pane = (await page.locator(".chat-pane").boundingBox())!;
        assert.ok(pane.x + pane.width <= width);
        // the log scrolls inside itself, never sideways
        assert.equal(await page.evaluate(() => { const l = document.querySelector("[role=log]")!; return l.scrollWidth <= l.clientWidth; }), true, "log overflows horizontally");
        // history is hidden while a conversation is open (list-detail pattern) and Back exists
        assert.equal(await page.getByRole("region", { name: "Chat history" }).isVisible(), false);
        assert.ok(await page.getByRole("button", { name: "Back to list" }).isVisible());
      });
    });
  }
});

describe("chat layout: wide (>= 1600 px)", opts, () => {
  for (const width of [1600, 2560]) {
    test(`${width} px: messages stop at ~72-80ch, the transcript is capped and centred, no sideways scroll`, async () => {
      await withChat({ route: "#/chat/ses_1", seed, width, height: 900 }, async ({ page }) => {
        await page.getByRole("log").getByText("indented", { exact: false }).waitFor();
        assert.equal(await noSideScroll(page), true);
        const r = await page.evaluate(() => {
          const ch = (el: Element): number => { const p = document.createElement("span"); p.style.cssText = "position:absolute;visibility:hidden;white-space:pre"; p.style.font = getComputedStyle(el).font; p.textContent = "0".repeat(100); document.body.appendChild(p); const w = p.getBoundingClientRect().width / 100; p.remove(); return w; };
          const texts = Array.from(document.querySelectorAll(".msg-text")).map((el) => ({ w: el.getBoundingClientRect().width, ch: ch(el) }));
          const pane = document.querySelector(".chat-pane")!.getBoundingClientRect();
          const main = document.querySelector("main")!.getBoundingClientRect();
          return { texts, pane: { x: pane.x, w: pane.width }, main: { x: main.x, w: main.width } };
        });
        for (const t of r.texts) assert.ok(t.w / t.ch <= 80, `message line ${Math.round(t.w / t.ch)}ch`);
        assert.ok(r.pane.w <= 820.5, `transcript ${r.pane.w}`);
        const history = await page.getByRole("region", { name: "Chat history" }).boundingBox();
        assert.ok(history && history.x + history.width <= r.pane.x + 1, "history sits left of the transcript");
        const log = await page.getByRole("log").boundingBox();
        assert.ok(log!.width <= 820.5);
        assert.equal(await page.evaluate(() => { const l = document.querySelector("[role=log]")!; return l.scrollWidth <= l.clientWidth; }), true);
      });
    });
  }

  test("2560 px, no history selected: the new-chat form stays centred and capped", async () => {
    await withChat({ route: "#/chat/new", seed, width: 2560, height: 900 }, async ({ page }) => {
      await page.getByRole("heading", { name: "Talk to an agent" }).waitFor();
      assert.equal(await noSideScroll(page), true);
      const w = await page.evaluate(() => document.querySelector(".chat-pane")!.getBoundingClientRect().width);
      assert.ok(w <= 820.5, `${w}`);
    });
  });
});
