// b20 audit: Models page, further fields of a catalog entry are shown, so credentials in them must not be.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isSecretKey, normalizeModel } from "../src/pages/models/model.ts";

describe("models: further fields never show a credential", () => {
  test("password, passphrase and authorization fields are masked like key, token and secret", () => {
    for (const k of ["password", "dbPassword", "passphrase", "authorization", "Authorization", "proxy_auth", "bearer"]) assert.equal(isSecretKey(k), true, k);
    for (const k of ["author", "region", "tokenizer", "keyboard", "family"]) assert.equal(isSecretKey(k), false, k);
  });

  test("a URL with credentials in it is shown without them", () => {
    const m = normalizeModel({ provider: "p", id: "m", baseUrl: "https://user:hunter2@example.test/v1", plain: "https://example.test/v1" });
    assert.equal(m?.extra.baseUrl, "https://••••@example.test/v1");
    assert.equal(m?.extra.plain, "https://example.test/v1");
  });
});

describe("models: privacy.localOnly lock (cloud models are listed as locked, never hidden)", () => {
  test("locked: local-only is kept as a known field and not repeated among the further fields", () => {
    const m = normalizeModel({ provider: "p", id: "m", locked: "local-only" });
    assert.equal(m?.locked, "local-only");
    assert.equal("locked" in (m?.extra ?? {}), false);
  });
  test("an unknown lock value or none leaves the model unlocked", () => {
    assert.equal("locked" in normalizeModel({ provider: "p", id: "m" })!, false);
    assert.equal("locked" in normalizeModel({ provider: "p", id: "m", locked: "other" })!, false);
  });
});
