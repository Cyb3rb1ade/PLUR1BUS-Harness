import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCaptionService, normaliseCaption } from "../../src/media-search/caption/service.ts";
import type { CaptionConfig } from "../../src/media-search/caption/types.ts";
import { FakeCaptionProvider } from "./fakes.ts";

const base = { kind: "image" as const, mime: "image/png", source: { bytes: new Uint8Array([1]) } };
const svc = (cfg: Partial<CaptionConfig>, provider?: FakeCaptionProvider) =>
  createCaptionService({ config: () => ({ source: "prompt-then-user-then-auto", maxChars: 280, ...cfg }), provider: () => provider });

describe("caption order", () => {
  it("prompt wins over user and auto", async () => {
    const p = new FakeCaptionProvider();
    assert.deepEqual(await svc({}, p).resolve({ ...base, prompt: "a red fox", userCaption: "my fox" }), { text: "a red fox", source: "prompt" });
    assert.equal(p.calls.length, 0);
  });
  it("user caption when there is no prompt, auto last", async () => {
    const p = new FakeCaptionProvider();
    assert.deepEqual(await svc({}, p).resolve({ ...base, userCaption: "  my   fox " }), { text: "my fox", source: "user" });
    assert.deepEqual(await svc({}, p).resolve({ ...base, prompt: "   " }), { text: "auto caption", source: "auto" });
    assert.equal(p.calls.length, 1);
  });
  it("user-only ignores prompt and auto", async () => {
    const p = new FakeCaptionProvider();
    const s = svc({ source: "user-only" }, p);
    assert.equal(await s.resolve({ ...base, prompt: "a prompt" }), null);
    assert.deepEqual(await s.resolve({ ...base, prompt: "a prompt", userCaption: "alt" }), { text: "alt", source: "user" });
    assert.equal(p.calls.length, 0);
  });
  it("off yields nothing", async () => {
    const p = new FakeCaptionProvider();
    assert.equal(await svc({ source: "off" }, p).resolve({ ...base, prompt: "x", userCaption: "y" }), null);
    assert.equal(p.calls.length, 0);
  });
  it("null without provider", async () => {
    assert.equal(await svc({}).resolve(base), null);
  });
});

describe("maxChars", () => {
  it("cuts at a word boundary with an ellipsis inside the limit", () => {
    const out = normaliseCaption("one two three four five six", 15);
    assert.equal(out, "one two three…");
    assert.ok(out.length <= 15);
  });
  it("leaves short text and normalises whitespace", () => {
    assert.equal(normaliseCaption("  a \n b\t c ", 20), "a b c");
  });
  it("handles a single long word", () => {
    const out = normaliseCaption("x".repeat(50), 20);
    assert.equal(out.length, 20);
    assert.ok(out.endsWith("…"));
  });
  it("applies to every source", async () => {
    const r = await svc({ maxChars: 20 }).resolve({ ...base, prompt: "a very long prompt about foxes and more" });
    assert.ok(r && r.text.length <= 20 && r.text.endsWith("…"));
  });
});
