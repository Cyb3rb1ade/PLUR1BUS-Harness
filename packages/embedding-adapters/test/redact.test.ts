import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactUrl } from "../src/redact.ts";

test("exact secret values are removed everywhere, including regex metacharacters", () => {
  const secret = "a+b(c)[d]*e?f";
  const out = redactSecrets(`failed with ${secret} and again ${secret}`, [secret]);
  assert.equal(out.includes(secret), false);
  assert.equal(out, "failed with [redacted] and again [redacted]");
});

test("url-encoded and json-escaped forms of a secret are removed too", () => {
  const secret = 'p@ss/word"x y';
  const encoded = encodeURIComponent(secret);
  const escaped = JSON.stringify(secret).slice(1, -1);
  const out = redactSecrets(`q=${encoded} body=${escaped}`, [secret]);
  assert.equal(out.includes(encoded), false);
  assert.equal(out.includes(escaped), false);
});

test("very short secrets are ignored instead of shredding the message", () => {
  assert.equal(redactSecrets("a message", ["a"]), "a message");
});

test("bearer tokens are masked", () => {
  assert.equal(redactSecrets("Authorization: Bearer abc.def-123_xyz", []).includes("abc.def-123_xyz"), false);
  assert.match(redactSecrets("got Bearer abc.def-123_xyz here", []), /Bearer \[redacted\]/);
});

test("key=value and header style pairs are masked", () => {
  const out = redactSecrets("GET /v1/x?key=AIzaSyA1234567890abcdefghij&alt=json x-goog-api-key: AIzaSyA1234567890abcdefghij api_key=\"hunter2hunter2\"", []);
  assert.equal(out.includes("AIzaSyA1234567890abcdefghij"), false);
  assert.equal(out.includes("hunter2hunter2"), false);
  assert.match(out, /alt=json/);
});

test("vendor token shapes echoed back by a server are masked", () => {
  const echoed = 'Incorrect API key provided: sk-live-abcdef1234567890. See jina_0123456789abcdef0123456789abcdef.';
  const out = redactSecrets(echoed, []);
  assert.equal(out.includes("sk-live-abcdef1234567890"), false);
  assert.equal(out.includes("jina_0123456789abcdef0123456789abcdef"), false);
  assert.match(out, /Incorrect API key provided/);
});

test("credentials embedded in a url authority are masked", () => {
  const out = redactSecrets("redirect to https://user:s3cr3tpass@evil.example/x", []);
  assert.equal(out.includes("s3cr3tpass"), false);
  assert.equal(out.includes("user:"), false);
});

test("ordinary text is left untouched", () => {
  const msg = "expected 1536 dimensions, got 768 for text-embedding-3-small";
  assert.equal(redactSecrets(msg, []), msg);
});

test("redactUrl drops userinfo and masks sensitive query values", () => {
  assert.equal(redactUrl("https://u:p@host.example/path?key=abc123&alt=json#frag"), "https://host.example/path?key=%5Bredacted%5D&alt=json");
  assert.equal(redactUrl("not a url with key=abc12345"), "not a url with key=[redacted]");
});
