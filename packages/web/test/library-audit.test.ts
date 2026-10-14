import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import type { MockHarnessServer } from "./mock-server.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  agentId: "main",
  prompt: `Prompt ${n}`,
  kind: "image",
  createdAt: n,
  metadata: { adapter: "local" },
  files: [{ path: "0.png", format: "png", bytes: 1 }],
  ...extra,
});

function serve(server: MockHarnessServer, outputs: unknown[]): void {
  server.rpc.handle("media.output.list", () => ({ outputs }), { write: false });
  server.rpc.handle("media.output.get", (p: any) => ({
    manifest: outputs.find((o: any) => o?.id === p.id) ?? null,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    mimeType: "image/png",
  }), { write: false });
}
const open = async (page: Page): Promise<void> => {
  await openRoute(page, "#/library");
  await page.getByRole("heading", { name: "Media Library", level: 1 }).waitFor();
};

describe("Library page audit", opts, () => {
  test("malformed list entries are skipped instead of taking the page down", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, [null, 7, { id: 5 }, item(1)]);
      await open(page);
      await page.getByText("Prompt 1", { exact: true }).waitFor();
      assert.equal(await page.locator(".library-card").count(), 1);
    });
  });

  test("a non-array outputs field is treated as empty", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, []);
      server.rpc.handle("media.output.list", () => ({ outputs: { oops: true } }), { write: false });
      await open(page);
      await page.locator('[data-state="empty"]').waitFor();
    });
  });

  test("the thumbnail opens the preview with Enter and Space", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, [item(1)]);
      await open(page);
      const thumb = page.locator(".library-thumb-wrapper");
      await thumb.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.className), "library-thumb-wrapper");
      await page.keyboard.press("Space");
      await page.getByRole("dialog").waitFor();
    });
  });

  test("preview: Escape closes it and focus returns to the Preview button; Tab stays inside", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, [item(1)]);
      await open(page);
      const btn = page.getByRole("button", { name: "Preview", exact: true });
      await btn.focus();
      await page.keyboard.press("Enter");
      const dlg = page.getByRole("dialog");
      await dlg.waitFor();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        assert.ok(await page.evaluate(() => !!document.activeElement?.closest("dialog")), "focus escaped the dialog");
      }
      await page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(await btn.evaluate((e) => e === document.activeElement), true);
    });
  });

  test("thumbnails carry a descriptive alt text (caption, else prompt), not the job id", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, [item(1, { caption: "Sunrise over the lake" }), item(2)]);
      await open(page);
      await page.locator(".library-card img").first().waitFor();
      const alts = await page.locator(".library-card img").evaluateAll((l) => l.map((i) => i.getAttribute("alt")));
      assert.deepEqual(alts.sort(), ["Prompt 2", "Sunrise over the lake"]);
    });
  });

  test("the caption field has an accessible name; cancelling discards the draft", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, [item(1, { caption: "Original" })]);
      await open(page);
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page.getByRole("button", { name: "Edit caption" }).click();
      const box = page.getByRole("textbox", { name: "Caption" });
      await box.fill("Draft nobody saved");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("dialog").getByText("Original", { exact: true }).waitFor();
    });
  });

  test("a viewer can neither delete nor edit captions", async () => {
    await withApp({ server: { role: "viewer" } }, async ({ page, server }) => {
      serve(server, [item(1, { caption: "c" })]);
      await open(page);
      await page.getByText("Prompt 1", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Delete" }).count(), 0);
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.getByRole("button", { name: "Delete" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Edit caption" }).count(), 0);
    });
  });

  test("a large library is shown a page at a time", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, Array.from({ length: 60 }, (_, i) => item(i + 1)));
      await open(page);
      await page.locator(".library-card").first().waitFor();
      assert.equal(await page.locator(".library-card").count(), 24);
      await page.getByRole("button", { name: "Show more" }).click();
      assert.equal(await page.locator(".library-card").count(), 48);
      await page.getByRole("button", { name: "Show more" }).click();
      assert.equal(await page.locator(".library-card").count(), 60);
      assert.equal(await page.getByRole("button", { name: "Show more" }).count(), 0);
    });
  });

  test("a filter without matches says so instead of claiming the library is empty", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, [item(1)]);
      await open(page);
      await page.locator("#kind-filter").selectOption("video");
      await page.getByText("No media of this type.").waitFor();
      assert.equal(await page.getByText("No media in library yet.").count(), 0);
    });
  });

  test("audio and video cards show a type label instead of an empty tile", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, [item(1, { kind: "audio", files: [{ path: "0.wav", format: "wav", bytes: 1 }] })]);
      server.rpc.handle("media.output.get", () => ({ manifest: item(1), data: "UE5H", mimeType: "audio/wav" }), { write: false });
      await open(page);
      await page.locator(".library-thumb-wrapper").getByText("Audio", { exact: true }).waitFor();
    });
  });

  test("very long unbroken and Unicode names stay inside card and dialog", async () => {
    const long = "文件名".repeat(60) + "_" + "x".repeat(300) + "🙂";
    await withApp({ width: 700 }, async ({ page, server }) => {
      serve(server, [item(1, { prompt: long, caption: long })]);
      await open(page);
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("dialog").locator("summary").click();
      const overflow = await page.evaluate(() => {
        const d = document.querySelector("dialog")!;
        return { dlg: d.scrollWidth - d.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      assert.ok(overflow.dlg <= 1 && overflow.doc <= 1, JSON.stringify(overflow));
    });
  });

  test("axe: list and open preview have no serious or critical violations", async () => {
    await withApp({}, async ({ page, server }) => {
      serve(server, [item(1, { caption: "c" }), item(2)]);
      await open(page);
      await page.locator(".library-card img").first().waitFor();
      await expectAxeClean(page, "library list");
      await page.getByRole("button", { name: "Preview", exact: true }).first().click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("button", { name: "Edit caption" }).click();
      await expectAxeClean(page, "library preview");
    });
  });
});
