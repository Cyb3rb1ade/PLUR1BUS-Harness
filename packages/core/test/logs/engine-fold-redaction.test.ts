import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRedactor } from "../../src/logs/redact.ts";

describe("RE-08 pinned engine credential redaction fold", () => {
  const redact = createRedactor();

  it("removes complete quoted Bearer values while preserving surrounding text", () => {
    for (const quote of ['"', "'"])
      assert.equal(
        redact.text(`failed Bearer ${quote}FAKE first second${quote} retry`),
        "failed [REDACTED:pattern] retry",
      );
  });

  it("removes every folded Authorization continuation while retaining the next header", () => {
    assert.equal(redact.text("Authorization: FAKE first"), "Authorization: [REDACTED:key]");
    for (const newline of ["\n", "\r\n"]) {
      const input = `Authorization: FAKE first${newline} FAKE second${newline}\tFAKE third${newline}X-Request: public`;
      const out = redact.text(input);
      assert.equal(
        out,
        `Authorization: [REDACTED:key]${newline}X-Request: public`,
      );
      assert.equal(redact.text(out), out);
    }
  });

  it("redacts access keys in text and structured values", () => {
    for (const name of ["access_key", "access-key-id", "accessKeyId"])
      assert.equal(
        redact.text(`retry ${name}="FAKE value spaces" attempt=2`),
        `retry ${name}="[REDACTED:key]" attempt=2`,
      );
    assert.deepEqual(
      redact.value({ access_key: "FAKE first", "access-key-id": "FAKE second", credentials_count: 2 }),
      { access_key: "[REDACTED:key]", "access-key-id": "[REDACTED:key]", credentials_count: 2 },
    );
  });

  it("redacts credential text assignments while preserving registered structured values", () => {
    for (const name of ["credential", "client_credential"]) {
      assert.equal(redact.text(`${name}=FAKE-value`), `${name}=[REDACTED:key]`);
      const out = redact.text(`retry ${name}="FAKE first second" attempt=2`);
      assert.ok(!out.includes("FAKE") && !out.includes("second"), out);
      assert.ok(out.endsWith(" attempt=2"), out);
    }
    const registered = createRedactor({ secrets: ["FAKE-registered-value"] });
    assert.deepEqual(registered.value({ credential: "FAKE-registered-value" }), { credential: "[REDACTED:secret]" });
  });

  it("preserves JSON quoting and repeated redaction for credential assignments", () => {
    for (const name of ["credential", "client_credential"]) {
      const input = JSON.stringify({ [name]: 'FAKE first " quoted second' });
      const out = redact.text(input);
      assert.deepEqual(JSON.parse(out), { [name]: "[REDACTED:key]" });
      assert.equal(redact.text(out), out);
    }
  });

  it("redacts bare Telegram bot credentials without requiring a URL", () => {
    const token = "123456789:" + "FAKE_bot_value-0123456789/+=.";
    assert.equal(redact.text(`failed ${token} retry`), "failed [REDACTED:pattern] retry");
    assert.equal(redact.text("123456789:short"), "123456789:short");
    assert.equal(redact.text("123456789/status"), "123456789/status");
  });

  it("retains the catalogue's documented sk and GitHub minimum lengths", () => {
    for (const text of ["sk-FAKE0123", "gho_" + "F".repeat(30)]) assert.equal(redact.text(text), text);
    assert.equal(redact.text("sk-" + "F".repeat(20)), "[REDACTED:pattern]");
    assert.equal(redact.text("gho_" + "F".repeat(36)), "[REDACTED:pattern]");
  });
});
