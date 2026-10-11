import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const sampleOutputs = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    agentId: "main",
    prompt: "A beautiful mountain",
    kind: "image",
    createdAt: 1000,
    metadata: { adapter: "local" },
    caption: "Mountain at sunrise",
    files: [{ path: "0.png", format: "png", bytes: 100 }],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    agentId: "main",
    prompt: "An ocean wave sound",
    kind: "audio",
    createdAt: 2000,
    metadata: { adapter: "local" },
    files: [{ path: "0.wav", format: "wav", bytes: 200 }],
  },
];

describe("Library page (media library)", opts, () => {
  test("loads media list, filters by type (image/video/audio), and links to media search", async () => {
    await withApp({}, async ({ page, server }) => {
      server.rpc.handle("media.output.list", () => ({ outputs: sampleOutputs }), { write: false });

      await openRoute(page, "#/library");
      await page.getByRole("heading", { name: "Media Library", level: 1 }).waitFor();

      // Check media items displayed
      await page.getByText("A beautiful mountain").waitFor();
      await page.getByText("An ocean wave sound").waitFor();

      // Link to media search exists
      const searchLink = page.locator('a[href="#/media"]');
      await searchLink.waitFor();
      assert.equal(await searchLink.textContent(), "Go to Media Search");

      // Filter by audio
      const filterSelect = page.locator("#kind-filter");
      await filterSelect.selectOption("audio");

      // Ocean wave stays, Mountain disappears
      await page.getByText("An ocean wave sound").waitFor();
      assert.equal(await page.getByText("A beautiful mountain").count(), 0);
    });
  });

  test("preview dialog and caption editing via media.caption.set", async () => {
    let savedCaption: { mediaId: string; text: string } | null = null;

    await withApp({}, async ({ page, server }) => {
      server.rpc.handle("media.output.list", () => ({ outputs: [sampleOutputs[0]] }), { write: false });
      server.rpc.handle("media.output.get", () => ({
        manifest: sampleOutputs[0],
        data: "UE5H",
        mimeType: "image/png",
        canShare: true,
      }), { write: false });
      server.rpc.handle("media.caption.set", (p: any) => {
        savedCaption = p;
        return { ok: true };
      }, { write: true });

      await openRoute(page, "#/library");
      await page.getByRole("heading", { name: "Media Library", level: 1 }).waitFor();

      // Open preview dialog using exact button
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page.locator(".library-dialog-content").waitFor();

      // Caption is shown in dialog
      await page.getByRole("dialog").getByText("Mountain at sunrise", { exact: true }).waitFor();

      // Edit caption
      await page.getByRole("button", { name: "Edit caption" }).click();
      const textarea = page.locator(".library-caption-textarea");
      await textarea.fill("Updated caption test");
      await page.getByRole("button", { name: "Save caption" }).click();

      // Verify media.caption.set was invoked with correct parameters
      await page.waitForFunction(() => document.querySelector(".library-caption-edit") === null);
      assert.deepEqual(savedCaption, {
        mediaId: sampleOutputs[0]!.id,
        text: "Updated caption test",
      });
    });
  });

  test("deletion with confirmation dialog calls media.output.delete", async () => {
    let deletedId: string | null = null;

    await withApp({}, async ({ page, server }) => {
      server.rpc.handle("media.output.list", () => ({ outputs: [sampleOutputs[0]] }), { write: false });
      server.rpc.handle("media.output.delete", (p: any) => {
        deletedId = p.id;
        return { deleted: true };
      }, { write: true });

      await openRoute(page, "#/library");
      await page.getByRole("heading", { name: "Media Library", level: 1 }).waitFor();

      // Click delete button on card
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      // Confirmation dialog appears
      const confirmDialog = page.getByRole("dialog").last();
      await confirmDialog.waitFor();
      await page.getByText("Are you sure you want to delete this media item?").waitFor();

      // Confirm deletion inside the dialog
      const confirmBtn = confirmDialog.getByRole("button", { name: "Delete", exact: true });
      await confirmBtn.click();

      // Verify RPC was called
      await page.waitForFunction(() => document.querySelector(".confirm-body") === null);
      assert.equal(deletedId, sampleOutputs[0]!.id);
    });
  });

  test("unavailable state when media.output.list is not served by backend", async () => {
    await withApp({}, async ({ page, server }) => {
      server.rpc.handle("media.output.list", () => ({ outputs: [] }), { write: false });
      server.rpc.scenario("media.output.list", "unavailable");

      await openRoute(page, "#/library");
      await page.getByRole("heading", { name: "Media Library", level: 1 }).waitFor();

      // Shows unavailable state
      await page.locator('[data-state="unavailable"]').waitFor();
      await page.getByText("Media service is not available on this harness.").waitFor();
    });
  });
});
