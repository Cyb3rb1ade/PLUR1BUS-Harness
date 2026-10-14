// Media search hardening (audit c20): answers of the wrong shape, an answer that arrives after the person cleared the search, and
// a media file whose type is not audio or video.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seedMedia, HIT_AUDIO, HIT_IMAGE } from "./media-search-fixtures.ts";
import { parseHits, playableType } from "../src/pages/media-search/model.ts";

before(setup);
after(teardown);

describe("media search: readers", () => {
  test("parseHits keeps well-formed hits and drops the rest; a non-list is null", () => {
    assert.equal(parseHits(undefined), null);
    assert.equal(parseHits({}), null);
    assert.equal(parseHits({ hits: "x" }), null);
    assert.deepEqual(parseHits({ hits: [] }), []);
    const good = { mediaId: "a", kind: "video", score: 0.5, segment: { idx: 0, startMs: 1000, endMs: 2000 }, caption: "c" };
    const hits = parseHits({ hits: [
      good,
      { mediaId: "b", kind: "image" },
      { mediaId: "c", kind: "pdf", score: 1 },
      { mediaId: 7, kind: "image", score: 1 },
      { mediaId: "d", kind: "image", score: Number.NaN },
      { mediaId: "e", kind: "audio", score: 0.1, segment: { idx: 0, startMs: "1", endMs: 2 } },
      null,
    ] });
    assert.deepEqual(hits, [good, { mediaId: "e", kind: "audio", score: 0.1 }]);
  });
  test("a media file is playable only when its type is audio or video and the hit is not an image", () => {
    assert.equal(playableType("audio/wav", "audio"), true);
    assert.equal(playableType("video/mp4", "video"), true);
    assert.equal(playableType("video/mp4; codecs=avc1", "video"), true);
    assert.equal(playableType("text/html", "audio"), false);
    assert.equal(playableType("audio/mp4", "video"), true);
    assert.equal(playableType("audio/wav;base64,AAAA", "audio"), false);
    assert.equal(playableType("image/png", "image"), false);
  });
});

const IMAGE_LIST = { outputs: [{ id: "med-image-1", prompt: "a red bridge", agentId: "main", metadata: { adapter: "local" }, createdAt: "2026-10-10T10:00:00Z", files: 1, kind: "image", mimeType: "image/png" }] };
const search = async (app: App, text = "rain"): Promise<void> => {
  await app.page.getByLabel("Describe what you are looking for").fill(text);
  await app.page.getByRole("button", { name: "Search", exact: true }).click();
};

describe("media search: in the browser", { skip: browserSkip }, () => {
  test("hits of the wrong shape say the search failed instead of taking the page down", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc);
      app.server.rpc.handle("media.search", () => ({ hits: [{ mediaId: "x", kind: "image" }] }), { write: false });
      await openRoute(app.page, "#/media");
      await search(app);
      await app.page.getByText("No media matched this search.").waitFor();
      app.server.rpc.handle("media.search", () => ({}), { write: false });
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByRole("alert").getByText("The search failed. Try again.").waitFor();
      assert.equal(await app.page.getByLabel("Describe what you are looking for").count(), 1);
    });
  });

  test("an answer that arrives after Clear similar search is not shown", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc);
      app.server.rpc.handle("media.output.list", () => IMAGE_LIST, { write: false });
      app.server.rpc.handle("media.search", async () => { await new Promise((r) => setTimeout(r, 900)); return { hits: [HIT_AUDIO, HIT_IMAGE] }; }, { write: false });
      await openRoute(app.page, "#/media");
      await app.page.getByRole("button", { name: "Find similar" }).first().click();
      await app.page.getByRole("status").filter({ hasText: "Similar to med-image-1" }).waitFor();
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByRole("button", { name: "Searching…" }).waitFor();
      await app.page.getByRole("button", { name: "Clear similar search" }).click();
      await app.page.getByRole("button", { name: "Search", exact: true }).waitFor();
      await app.page.waitForTimeout(1300);
      assert.equal(await app.page.locator("li.media-hit").count(), 0);
    });
  });

  test("a file whose type is not audio or video is not put into the player", async () => {
    await withApp({}, async (app) => {
      seedMedia(app.server.rpc);
      app.server.rpc.handle("media.output.get", () => ({ data: "PGI+aGk8L2I+", mimeType: "text/html" }), { write: false });
      await openRoute(app.page, "#/media");
      await search(app);
      await app.page.getByRole("button", { name: "Play from 0:12" }).click();
      await app.page.getByRole("alert").getByText("The search failed. Try again.").waitFor();
      assert.equal(await app.page.locator("audio, video").count(), 0);
    });
  });
});
