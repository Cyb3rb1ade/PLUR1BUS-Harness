import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMediaEmbedding, validateCaptionProvider, type MediaProviderCatalog, type MediaModelInfo } from "../../src/media-search/validate.ts";

const gemma: MediaModelInfo = { local: true, capabilities: { text: true, image: true, video: true, audio: true }, licence: { id: "gemma", nonCommercial: false }, dimensions: [768, 512, 256, 128] };
const models: Record<string, MediaModelInfo> = {
  "local/gemma": gemma,
  "cloud/textonly": { ...gemma, local: false, capabilities: { text: true, image: false, video: false, audio: false } },
  "cloud/full": { ...gemma, local: false },
  "local/nc": { ...gemma, licence: { id: "nc-1", nonCommercial: true } },
};
const catalog: MediaProviderCatalog = { lookup: (p, m) => models[`${p}/${m}`] };
const ctx = (over: Partial<Parameters<typeof validateMediaEmbedding>[1]> = {}) => ({ catalog, privacyPinned: false, licenceAccepted: () => false, available: () => true, ...over });
const code = (c: string) => (e: unknown) => (e as { error?: string }).error === c;

describe("validateMediaEmbedding", () => {
  it("accepts a local full-capability model", async () => {
    await validateMediaEmbedding({ provider: "local", model: "gemma", dimensions: 768 }, ctx());
  });
  it("off / disabled skips every check", async () => {
    const c = ctx({ privacyPinned: true, available: () => { throw new Error("must not be called"); } });
    await validateMediaEmbedding({ provider: "off" }, c);
    await validateMediaEmbedding({ enabled: false, provider: "cloud", model: "textonly" }, c);
  });
  it("capability: configured modality unsupported", async () => {
    await assert.rejects(validateMediaEmbedding({ provider: "cloud", model: "textonly", modalities: ["image"] }, ctx()), code("E_MEDIA_CAPABILITY"));
    await assert.rejects(validateMediaEmbedding({ provider: "cloud", model: "textonly" }, ctx()), code("E_MEDIA_CAPABILITY"));
  });
  it("capability: only the configured modalities count", async () => {
    models["cloud/imageonly"] = { ...gemma, local: false, capabilities: { text: true, image: true, video: false, audio: false } };
    await validateMediaEmbedding({ provider: "cloud", model: "imageonly", modalities: ["image"] }, ctx());
  });
  it("licence: non-commercial needs acceptance", async () => {
    await assert.rejects(validateMediaEmbedding({ provider: "local", model: "nc" }, ctx()), code("E_MEDIA_LICENSE"));
    await validateMediaEmbedding({ provider: "local", model: "nc" }, ctx({ licenceAccepted: (m) => m === "nc" }));
  });
  it("privacy: pin + cloud rejects without any availability request", async () => {
    let asked = 0;
    await assert.rejects(validateMediaEmbedding({ provider: "cloud", model: "full" }, ctx({ privacyPinned: true, available: () => { asked++; return true; } })), code("E_MEDIA_PRIVACY"));
    assert.equal(asked, 0);
    await validateMediaEmbedding({ provider: "local", model: "gemma" }, ctx({ privacyPinned: true }));
  });
  it("unavailable: unknown provider or not installed (sync or async)", async () => {
    await assert.rejects(validateMediaEmbedding({ provider: "nope", model: "x" }, ctx()), code("E_MEDIA_UNAVAILABLE"));
    await assert.rejects(validateMediaEmbedding({ provider: "local", model: "gemma" }, ctx({ available: async () => false })), code("E_MEDIA_UNAVAILABLE"));
  });
  it("dimension must be one the model supports", async () => {
    await assert.rejects(validateMediaEmbedding({ provider: "local", model: "gemma", dimensions: 1000 }, ctx()), code("E_MEDIA_DIMENSION"));
  });
});

describe("validateCaptionProvider", () => {
  it("no provider, off, or caption.source off is valid", async () => {
    await validateCaptionProvider({}, ctx());
    await validateCaptionProvider({ caption: { provider: "off" } }, ctx());
    await validateCaptionProvider({ caption: { provider: "cloud", model: "full", source: "off" } }, ctx({ privacyPinned: true }));
  });
  it("privacy, availability, licence and unknown provider", async () => {
    await assert.rejects(validateCaptionProvider({ caption: { provider: "cloud", model: "full" } }, ctx({ privacyPinned: true })), code("E_MEDIA_PRIVACY"));
    await assert.rejects(validateCaptionProvider({ caption: { provider: "local", model: "gemma" } }, ctx({ available: () => false })), code("E_MEDIA_UNAVAILABLE"));
    await assert.rejects(validateCaptionProvider({ caption: { provider: "zzz", model: "x" } }, ctx()), code("E_MEDIA_UNAVAILABLE"));
    await assert.rejects(validateCaptionProvider({ caption: { provider: "local", model: "nc" } }, ctx()), code("E_MEDIA_LICENSE"));
    await validateCaptionProvider({ caption: { provider: "local", model: "gemma" } }, ctx());
  });
});
