// Audit c19: the media page fetches only the images that are on screen.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);

const out = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  agentId: "main", prompt: `Forest ${i}`, createdAt: i, metadata: { adapter: "fake", model: "fixture" },
  files: [{ path: "0.png", bytes: 3, format: "png" }],
});

describe("media page", { skip: browserSkip }, () => {
  test("a long list is paged: only the visible page loads its images", async () => {
    await withApp({}, async (app) => {
      const all = Array.from({ length: 60 }, (_, i) => out(i + 1));
      app.server.rpc.handle("media.output.list", () => ({ outputs: all }), { write: false });
      app.server.rpc.handle("media.output.get", () => ({ data: "UE5H", mimeType: "image/png" }), { write: false });
      await openRoute(app.page, "#/media");
      await app.page.getByText("Forest 1", { exact: true }).waitFor();
      await app.page.waitForTimeout(300);
      const gets = () => app.server.rpc.calls.filter((c) => c.method === "media.output.get").length;
      assert.ok(gets() <= 24, `at most one page of images requested, got ${gets()}`);
      assert.ok(await app.page.locator(".media-grid article").count() <= 24);
      const next = app.page.getByRole("button", { name: /^Next page$/ });
      await next.click();
      await app.page.getByText("Forest 25", { exact: true }).waitFor();
      assert.equal(await app.page.getByText("Forest 1", { exact: true }).count(), 0);
    });
  });
});
