import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DisabledMediaIndex, isDisabledMediaIndex } from "../../src/media-search/disabled.ts";
import { scope } from "./helpers.ts";

const HINT = "Engine-Version unterstützt Medienindex noch nicht";
const unavailable = (e: unknown) => (e as { error?: string }).error === "E_MEDIA_UNAVAILABLE" && String((e as Error).message).includes(HINT);

describe("DisabledMediaIndex", () => {
  const d = new DisabledMediaIndex();
  it("throws E_MEDIA_UNAVAILABLE with the German hint on every call", async () => {
    await assert.rejects(d.search({ text: "x", limit: 1, scope: scope() }), unavailable);
    await assert.rejects(d.index({ mediaId: "m", kind: "image", mime: "image/png", source: { bytes: new Uint8Array() }, scope: scope() }), unavailable);
    await assert.rejects(d.remove("m"), unavailable);
    await assert.rejects(d.setCaption("m", "t", "user"), unavailable);
    await assert.rejects(d.backfill.start({ reason: "manual" }), unavailable);
    await assert.rejects(d.backfill.pause(), unavailable);
    await assert.rejects(d.backfill.resume(), unavailable);
    await assert.rejects(d.backfill.cancel(), unavailable);
  });
  it("status does not throw and reports disabled", async () => {
    const s = await d.status();
    assert.equal(s.enabled, false);
    assert.deepEqual(s.counts, { indexed: 0, pending: 0, failed: 0, unsupported: 0 });
    assert.equal(s.backfill.state, "idle");
  });
  it("keeps the hint when a reason is given and is detectable", async () => {
    const r = new DisabledMediaIndex("off by config");
    await assert.rejects(r.remove("m"), (e) => unavailable(e) && String((e as Error).message).includes("off by config"));
    assert.equal(isDisabledMediaIndex(r), true);
    assert.equal(isDisabledMediaIndex({}), false);
  });
});
