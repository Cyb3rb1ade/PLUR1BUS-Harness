import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMediaEmbedding, validateCaptionProvider } from "../../src/media-search/validate.ts";
import { resolveCaptionProvider } from "../../src/media-search/caption/service.ts";
import { FakeCaptionProvider } from "./fakes.ts";
const ack = { provider: "cloud", acknowledgedAt: "2026-10-14T10:00:00Z", by: "alice" };
const ctx = { catalog: { lookup: () => ({ local: false, capabilities: { text: true, image: true, video: true, audio: true }, licence: { id: "test", nonCommercial: false }, dimensions: [768] }) }, privacyPinned: false, licenceAccepted: () => true, available: () => true };
const privacy = (e: any) => e.error === "E_MEDIA_PRIVACY";
test("cloud embedding and captioning require their own acknowledgment before availability", async () => {
    let requests = 0;
    const c = { ...ctx, available: () => { requests++; return true; } };
    await assert.rejects(validateMediaEmbedding({ provider: "cloud", model: "test" }, c), privacy);
    await assert.rejects(validateCaptionProvider({ privacyAck: ack, caption: { provider: "cloud", model: "test" } } as any, c), privacy);
    assert.equal(requests, 0);
    await validateMediaEmbedding({ provider: "cloud", model: "test", privacyAck: ack } as any, c);
    await validateCaptionProvider({ caption: { provider: "cloud", model: "test", privacyAck: ack } } as any, c);
    assert.equal(requests, 2);
});
test("caption runtime refuses missing and mismatched acknowledgments before provider lookup; pin wins", () => {
    let lookups = 0;
    const cloud = new FakeCaptionProvider("cloud", false);
    const providers = { cloud: () => { lookups++; return cloud; } };
    assert.throws(() => resolveCaptionProvider({ config: { provider: "cloud" }, pinned: false, providers }), privacy);
    assert.throws(() => resolveCaptionProvider({ config: { provider: "other", privacyAck: ack } as any, pinned: false, providers }), privacy);
    assert.throws(() => resolveCaptionProvider({ config: { provider: "cloud", privacyAck: ack } as any, pinned: true, providers }), privacy);
    assert.equal(lookups, 0);
    assert.equal(resolveCaptionProvider({ config: { provider: "cloud", privacyAck: ack } as any, pinned: false, providers }), cloud);
});
test("synthetic media validation rechecks its own acknowledgment and pin", async () => {
    let calls = 0;
    const current = { ...ctx, available: () => { calls++; return true; } };
    const cfg = { provider: "cloud", model: "test", privacyAck: ack };
    await validateMediaEmbedding(cfg, current);
    assert.equal(calls, 1);
    await assert.rejects(validateMediaEmbedding(cfg, { ...current, privacyPinned: true }), privacy);
    assert.equal(calls, 1);
    await assert.rejects(validateMediaEmbedding({ ...cfg, privacyAck: { ...ack, provider: "other" } }, current), privacy);
    assert.equal(calls, 1);
});
