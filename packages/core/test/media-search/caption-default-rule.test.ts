import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCaptionProvider, resolveCaptionProvider } from "../../src/media-search/caption/service.ts";
import { FakeCaptionProvider } from "./fakes.ts";

describe("default caption provider", () => {
  it("local embedding preselects local", () => assert.equal(defaultCaptionProvider(true), "local"));
  it("cloud embedding preselects nothing", () => assert.equal(defaultCaptionProvider(false), undefined));
  it("resolve follows the rule when unset", () => {
    const local = new FakeCaptionProvider("local", true);
    const providers = { local };
    assert.equal(resolveCaptionProvider({ config: {}, pinned: false, providers, embeddingLocal: true }), local);
    assert.equal(resolveCaptionProvider({ config: {}, pinned: false, providers, embeddingLocal: false }), undefined);
  });
  it("off disables, explicit local wins", () => {
    const local = new FakeCaptionProvider("local", true);
    assert.equal(resolveCaptionProvider({ config: { provider: "off" }, pinned: false, providers: { local } }), undefined);
    assert.equal(resolveCaptionProvider({ config: { provider: "local" }, pinned: false, providers: { local }, embeddingLocal: false }), local);
  });
  it("configured cloud provider is looked up by id", () => {
    const cloud = new FakeCaptionProvider("openai", false);
    assert.equal(resolveCaptionProvider({ config: { provider: "openai" }, pinned: false, providers: { cloud: id => (id === "openai" ? cloud : undefined) } }), cloud);
  });
});
