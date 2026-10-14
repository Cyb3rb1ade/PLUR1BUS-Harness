import { test } from "node:test";
import assert from "node:assert/strict";
import { privacyAcknowledgmentError } from "../src/privacy.ts";
const ack = { provider: "cloud", acknowledgedAt: "2026-10-14T10:00:00Z", by: "owner" };
test("privacy acknowledgments bind the selected provider and exact configured endpoint", () => {
    assert.equal(privacyAcknowledgmentError({ function: "media", provider: "cloud", local: false, ack }), null);
    assert.equal(privacyAcknowledgmentError({ function: "media", provider: "other", local: false, ack })?.code, "E_MEDIA_PRIVACY");
    assert.equal(privacyAcknowledgmentError({ function: "caption", provider: "cloud", local: false, endpoint: "https://one.example/v1", ack })?.reason, "privacy-acknowledgment-mismatch");
    assert.equal(privacyAcknowledgmentError({ function: "caption", provider: "cloud", local: false, endpoint: "https://one.example/v1", ack: { ...ack, endpoint: "https://one.example/v1" } }), null);
    assert.equal(privacyAcknowledgmentError({ function: "caption", provider: "cloud", local: false, endpoint: "https://two.example/v1", ack: { ...ack, endpoint: "https://one.example/v1" } })?.code, "E_MEDIA_PRIVACY");
});
test("a runtime privacy pin takes precedence; local choices ignore acknowledgments", () => {
    assert.equal(privacyAcknowledgmentError({ function: "media", provider: "cloud", local: false, pinned: true, ack })?.reason, "privacy-pin");
    assert.equal(privacyAcknowledgmentError({ function: "caption", provider: "local", local: true, pinned: true, ack: { ...ack, provider: "other" } }), null);
    assert.equal(privacyAcknowledgmentError({ function: "text", provider: "cloud", local: false })?.code, "E_DENIED");
});
test("each function requires its own field, even when the provider is identical", () => {
    const choices = { media: ack, caption: undefined, text: undefined };
    assert.equal(privacyAcknowledgmentError({ function: "media", provider: "cloud", local: false, ack: choices.media }), null);
    assert.equal(privacyAcknowledgmentError({ function: "caption", provider: "cloud", local: false, ack: choices.caption })?.code, "E_MEDIA_PRIVACY");
    assert.equal(privacyAcknowledgmentError({ function: "text", provider: "cloud", local: false, ack: choices.text })?.code, "E_DENIED");
});
import { defaults, validate, CONFIG_SCHEMA } from "../src/index.ts";
test("config rejects cloud captioning without its own provider-bound acknowledgment", () => {
    const cfg: any = defaults();
    cfg.memory.mediaEmbedding.caption.provider = "openai";
    assert.equal(validate(cfg).ok, false);
    cfg.memory.mediaEmbedding.privacyAck = { ...ack, provider: "openai" };
    assert.equal(validate(cfg).ok, false);
    cfg.memory.mediaEmbedding.caption.privacyAck = { ...ack, provider: "openai" };
    assert.equal(validate(cfg).ok, true);
    cfg.memory.mediaEmbedding.caption.provider = "other";
    assert.equal(validate(cfg).ok, false);
});
test("optional acknowledgment schema is closed, dated and declares roles and audit", () => {
    const props = CONFIG_SCHEMA.properties.memory.properties;
    for (const node of [props.embedding.properties.privacyAck, props.mediaEmbedding.properties.privacyAck, props.mediaEmbedding.properties.caption.properties.privacyAck]) {
        assert.deepEqual(node["x-write-roles"], ["owner", "admin"]);
        assert.equal(node["x-audit"], true);
    }
    const cfg: any = defaults();
    cfg.memory.embedding = { privacyAck: ack };
    assert.equal(validate(cfg).ok, true);
    for (const patch of [{ acknowledgedAt: "invalid" }, { by: "" }, { extra: true }]) {
        cfg.memory.embedding.privacyAck = { ...ack, ...patch };
        assert.equal(validate(cfg).ok, false);
    }
    assert.equal(defaults().memory.embedding, undefined);
});
