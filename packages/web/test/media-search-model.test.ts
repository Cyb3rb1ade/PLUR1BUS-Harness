// Media search rules (pure, no browser): caption preselection, validation codes, config changes against the contract defaults,
// search params, time labels and the per-agent override. The browser behaviour is in media-search.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MEDIA_EMBEDDING_DEFAULTS } from "../src/pages/media-search/contract.ts";
import { ALL_MODALITIES, CLOUD_CAPTION_PROVIDER, SEARCH_LIMIT, captionPreselection, changesOf, clock, draftOf, effectiveCaption, jumpSeconds, mediaErrorOf, mediaSetupChanges, mediaSetupDefaults, problemText, searchParams, segmentLabel, toSetup, validateMedia, type MediaSetup } from "../src/pages/media-search/model.ts";
import { overrideChanges, overrideOf } from "../src/pages/media-search/override.ts";

const local = (m: Partial<MediaSetup> = {}): MediaSetup => ({ ...mediaSetupDefaults(), ...m });

describe("media search: contract defaults", () => {
  test("the TS defaults are the contract's: EmbeddingGemma 2, 768, all modalities, auto backfill, segment and frame limits", () => {
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.provider, "egemma2");
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.model, "google/embeddinggemma-2");
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.dimensions, 768);
    assert.deepEqual([...MEDIA_EMBEDDING_DEFAULTS.modalities], ["image", "video", "audio"]);
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.video.segmentSec, 10);
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.video.maxFrames, 32);
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.video.sceneDetect, true);
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.audio.segmentSec, 30);
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.audio.maxSeconds, 3600);
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.caption.maxChars, 280);
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.caption.perSegment, false);
    assert.equal(MEDIA_EMBEDDING_DEFAULTS.backfill, "auto");
  });
});

describe("media search: captioning preselection", () => {
  test("local embedding preselects local captioning", () => {
    assert.equal(captionPreselection("egemma2"), "local");
    assert.equal(effectiveCaption(local(), "egemma2"), "local");
  });
  test("cloud embedding preselects nothing: setup has to ask", () => {
    assert.equal(captionPreselection(CLOUD_CAPTION_PROVIDER), null);
    assert.equal(effectiveCaption(local(), CLOUD_CAPTION_PROVIDER), null);
  });
  test("an answer always wins over the preselection", () => {
    assert.equal(effectiveCaption(local({ caption: "off" }), "egemma2"), "off");
    assert.equal(effectiveCaption(local({ caption: CLOUD_CAPTION_PROVIDER }), CLOUD_CAPTION_PROVIDER), CLOUD_CAPTION_PROVIDER);
  });
});

describe("media search: validation (E_MEDIA_* mirror)", () => {
  test("the defaults are valid", () => {
    assert.deepEqual(validateMedia({ textProvider: "egemma2", media: local(), privacyPin: false, ncConfirmed: false }), []);
  });
  test("a media disabled needs no checks", () => {
    assert.deepEqual(validateMedia({ textProvider: CLOUD_CAPTION_PROVIDER, media: local({ enabled: false, provider: "openai", caption: null }), privacyPin: true, ncConfirmed: false }), []);
  });
  test("capability: a provider that cannot take a chosen modality is refused (OpenAI cannot be the media index)", () => {
    const codes = validateMedia({ textProvider: "egemma2", media: local({ provider: CLOUD_CAPTION_PROVIDER }), privacyPin: false, ncConfirmed: false }).map((p) => p.code);
    assert.ok(codes.includes("E_MEDIA_CAPABILITY"));
  });
  test("capability: a text-only local model is refused for media", () => {
    const codes = validateMedia({ textProvider: "egemma2", media: local({ provider: "qwen3-emb" }), privacyPin: false, ncConfirmed: false }).map((p) => p.code);
    assert.deepEqual(codes, ["E_MEDIA_CAPABILITY"]);
  });
  test("licence: a non-commercial media model needs its confirmation", () => {
    const codes = validateMedia({ textProvider: "egemma2", media: local({ provider: "jina-v5-nano" }), privacyPin: false, ncConfirmed: false }).map((p) => p.code);
    assert.ok(codes.includes("E_MEDIA_LICENSE"));
  });
  test("privacy: a set pin with a cloud captioner sends nothing and is named", () => {
    const codes = validateMedia({ textProvider: "egemma2", media: local({ caption: CLOUD_CAPTION_PROVIDER }), privacyPin: true, ncConfirmed: false }).map((p) => p.code);
    assert.deepEqual(codes, ["E_MEDIA_PRIVACY"]);
  });
  test("cloud embedding without a captioning choice blocks until the user picks one", () => {
    const codes = validateMedia({ textProvider: CLOUD_CAPTION_PROVIDER, media: local({ caption: null }), privacyPin: false, ncConfirmed: false }).map((p) => p.code);
    assert.deepEqual(codes, ["caption-required"]);
  });
  test("no modality left is a problem of its own", () => {
    const codes = validateMedia({ textProvider: "egemma2", media: local({ modalities: [] }), privacyPin: false, ncConfirmed: false }).map((p) => p.code);
    assert.deepEqual(codes, ["modalities-required"]);
  });
  test("an error object is read from error.data.error, unknown codes are ignored", () => {
    assert.equal(mediaErrorOf({ data: { error: "E_MEDIA_PRIVACY" } }), "E_MEDIA_PRIVACY");
    assert.equal(mediaErrorOf({ data: { error: "E_DENIED" } }), null);
    assert.equal(mediaErrorOf(new Error("x")), null);
  });
});

describe("media search: config changes only where a value differs from the contract default", () => {
  test("untouched defaults write nothing", () => {
    assert.deepEqual(mediaSetupChanges(local(), "egemma2"), []);
  });
  test("modalities: only the changed set is written, in full", () => {
    assert.deepEqual(mediaSetupChanges(local({ modalities: ["image", "audio"] }), "egemma2"), [{ key: "memory.mediaEmbedding.modalities", value: ["image", "audio"] }]);
  });
  test("media off writes enabled=false and nothing else", () => {
    assert.deepEqual(mediaSetupChanges(local({ enabled: false }), "egemma2"), [{ key: "memory.mediaEmbedding.enabled", value: false }]);
  });
  test("a cloud captioner is written as the caption provider; backfill manual and the source are written when changed", () => {
    const out = mediaSetupChanges(local({ caption: CLOUD_CAPTION_PROVIDER, backfill: "manual", captionSource: "user-only" }), "egemma2");
    assert.deepEqual(out, [
      { key: "memory.mediaEmbedding.caption.provider", value: CLOUD_CAPTION_PROVIDER },
      { key: "memory.mediaEmbedding.caption.source", value: "user-only" },
      { key: "memory.mediaEmbedding.backfill", value: "manual" },
    ]);
  });
  test("all modalities selected in another order is still the default (no write)", () => {
    assert.deepEqual(mediaSetupChanges(local({ modalities: ["audio", "video", "image"] }), "egemma2"), []);
    assert.deepEqual([...ALL_MODALITIES].sort(), ["audio", "image", "video"]);
  });
});

describe("media search: settings draft", () => {
  test("an empty configuration reads as the contract defaults and an unchanged draft writes nothing", () => {
    const d = draftOf({});
    assert.equal(d.enabled, true);
    assert.equal(d.caption.provider, "local");
    assert.deepEqual(changesOf(d, draftOf({})), []);
  });
  test("a changed video segment is the one changed key", () => {
    const before = draftOf({});
    const after = draftOf({});
    after.video.segmentSec = 20;
    assert.deepEqual(changesOf(before, after), [{ key: "memory.mediaEmbedding.video.segmentSec", value: 20 }]);
  });
  test("the draft maps to the setup model for the shared validation", () => {
    const d = draftOf({});
    d.provider = CLOUD_CAPTION_PROVIDER;
    const problems = validateMedia({ textProvider: "egemma2", media: toSetup(d), privacyPin: false, ncConfirmed: false });
    assert.ok(problems.some((p) => p.code === "E_MEDIA_CAPABILITY"));
  });
  test("a problem code has a text; an unknown one falls back to the generic text", () => {
    assert.match(problemText("E_MEDIA_PRIVACY"), /privacy pin/i);
    assert.match(problemText("caption-required"), /captions/i);
    assert.match(problemText("E_NOT_A_CODE"), /went wrong/i);
  });
});

describe("media search: query params", () => {
  test("text search sends text, limit 20 and no kinds filter when all kinds are on", () => {
    assert.deepEqual(searchParams({ text: "  forest ", kinds: ["image", "video", "audio"], fuseCaptions: false }), { text: "forest", limit: SEARCH_LIMIT });
  });
  test("a kinds filter is sent only when it narrows the search", () => {
    assert.deepEqual(searchParams({ text: "rain", kinds: ["image", "audio"], fuseCaptions: true }), { text: "rain", limit: 20, kinds: ["image", "audio"], fuseCaptions: true });
  });
  test("the schema's kinds tuple: one kind is sent as one item, no kind or all three send no filter", () => {
    assert.deepEqual(searchParams({ text: "rain", kinds: ["video"], fuseCaptions: false }), { text: "rain", limit: 20, kinds: ["video"] });
    assert.equal("kinds" in (searchParams({ text: "rain", kinds: [], fuseCaptions: false }) ?? {}), false);
  });
  test("find-similar sends likeMediaId and no text (exactly one of the two)", () => {
    const p = searchParams({ text: "ignored", likeMediaId: "med-1", kinds: ["image", "video", "audio"], fuseCaptions: false }) as Record<string, unknown>;
    assert.equal(p.likeMediaId, "med-1");
    assert.equal("text" in p, false);
  });
  test("nothing to search for gives null", () => {
    assert.equal(searchParams({ text: "   ", kinds: ["image"], fuseCaptions: false }), null);
  });
});

describe("media search: time labels and jumps", () => {
  test("clock labels with minutes and hours", () => {
    assert.equal(clock(0), "0:00");
    assert.equal(clock(12_000), "0:12");
    assert.equal(clock(75_000), "1:15");
    assert.equal(clock(3_725_000), "1:02:05");
  });
  test("a segment reads as a range and a jump goes to its start in seconds", () => {
    assert.equal(segmentLabel(20_000, 30_000), "0:20–0:30");
    assert.equal(jumpSeconds(12_000), 12);
    assert.equal(jumpSeconds(-5), 0);
  });
});

describe("media search: per-agent override", () => {
  const cfg = {
    agents: { main: { memory: { mediaEmbedding: { provider: "egemma2", caption: { provider: "off" } } } }, other: {} },
  };
  test("only the fields that the agent overrides are read; the rest inherit", () => {
    const own = overrideOf(cfg, "main");
    assert.equal(own.provider, "egemma2");
    assert.equal(own.captionProvider, "off");
    assert.equal(own.modalities, null);
    assert.equal(overrideOf(cfg, "other").provider, null);
  });
  test("a changed field is written under agents.<id>.memory.mediaEmbedding; an unchanged one is not", () => {
    const before = overrideOf(cfg, "main");
    const after = { ...before, captionSource: "user-only", provider: "egemma2" };
    assert.deepEqual(overrideChanges("main", before, after), [{ key: "agents.main.memory.mediaEmbedding.caption.source", value: "user-only" }]);
  });
  test("clearing a field writes null (the field inherits again)", () => {
    const before = overrideOf(cfg, "main");
    const after = { ...before, captionProvider: null };
    assert.deepEqual(overrideChanges("main", before, after), [{ key: "agents.main.memory.mediaEmbedding.caption.provider", value: null }]);
  });
});
