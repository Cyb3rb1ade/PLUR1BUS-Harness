import assert from "node:assert/strict";
import { test } from "node:test";
import { setLangPref } from "../src/i18n.ts";
import { attestationText } from "../src/attestation-text.ts";

test("attestation text: the required prompt names the method in the user's words, in en and de", () => {
  setLangPref("en");
  assert.equal(attestationText({ error: "E_APPROVAL_REQUIRED", reason: "attestation-required", detail: "touch-id" }), "Confirmation by Touch ID is needed. It covers this approval only.");
  assert.match(attestationText({ error: "E_APPROVAL_REQUIRED", reason: "attestation-required", detail: "windows-hello" })!, /Windows Hello/);
  assert.match(attestationText({ error: "E_APPROVAL_REQUIRED", reason: "attestation-required", detail: "polkit" })!, /system password/);
  setLangPref("de");
  assert.equal(attestationText({ error: "E_APPROVAL_REQUIRED", reason: "attestation-required", detail: "touch-id" }), "Bestätigung durch Touch ID nötig. Sie gilt nur für diese Freigabe.");
  assert.match(attestationText({ error: "E_APPROVAL_REQUIRED", reason: "attestation-required", detail: "windows-hello" })!, /Windows Hello/);
});

test("attestation text: each outcome has its own sentence, and an unknown method falls back to the system", () => {
  setLangPref("en");
  const texts = new Set<string>();
  for (const detail of ["cancelled", "timeout", "failed", "replay", "mismatch"]) {
    const x = attestationText({ error: "E_DENIED", reason: "attestation-failed", detail })!;
    assert.ok(x.length > 0);
    texts.add(x);
  }
  assert.ok(texts.size >= 3, "cancel, timeout and the rest are told apart");
  assert.match(attestationText({ error: "E_NOT_AVAILABLE", reason: "attestation-unavailable" })!, /not available/i);
  assert.match(attestationText({ error: "E_CONFLICT", reason: "attestation-in-progress" })!, /waiting/i);
  assert.match(attestationText({ error: "E_APPROVAL_REQUIRED", reason: "attestation-required", detail: "<script>" })!, /operating system/);
});

test("attestation text: anything that is not an attestation refusal is not ours", () => {
  assert.equal(attestationText({ error: "E_DENIED", reason: "surface-untrusted" }), null);
  assert.equal(attestationText({ error: null, reason: undefined }), null);
  assert.equal(attestationText({ error: "E_DENIED", reason: "attestation-failed-ish" }), null);
});
