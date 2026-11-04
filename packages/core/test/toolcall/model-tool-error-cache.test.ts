import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { modelToolError } from "../../src/toolcall/model-tool-error.ts";
import { SecretFormsCache } from "../../src/logs/secret-forms.ts";
import { SecretMatcher } from "../../src/logs/secret-matcher.ts";
import type { ToolFailure } from "../../src/tools/dispatcher.ts";

const failure = (message: string): ToolFailure => ({
  callId: "call", tool: "fixture.read", isError: true, error: { code: "tool-failed", message },
  provenance: { origin: { system: "tool:fixture.read", agent: "main", principal: "owner", trust: "first-party" },
    hops: 1, transformedBy: [] },
  meta: { decision: "allow", durationMs: 0, bytes: 0 },
});

test("model failures reuse raw-secret forms by membership and refresh on changes", t => {
  const first = randomUUID(), second = randomUUID();
  const encode = globalThis.encodeURIComponent;
  let derivations = 0;
  t.mock.method(globalThis, "encodeURIComponent", (value: string) => {
    if (value === first || value === second) derivations++;
    return encode(value);
  });
  const raw = failure(`failed with ${first} ${second}`);
  for (const values of [[first, second], [second, first, first]]) {
    const output = JSON.stringify(modelToolError(raw, values));
    assert.ok(!output.includes(first)); assert.ok(!output.includes(second));
  }
  assert.equal(derivations, 2, "repeated failures must reuse the compiled membership generation");
  const next = randomUUID();
  assert.ok(!JSON.stringify(modelToolError(failure(next), [next])).includes(next));
});

test("model failure options accept a compiled matcher without requiring raw secrets", t => {
  const secret = randomUUID();
  const snapshot = new SecretFormsCache().snapshot([secret]);
  const encode = globalThis.encodeURIComponent;
  let derivations = 0;
  t.mock.method(globalThis, "encodeURIComponent", (value: string) => {
    if (value === secret) derivations++;
    return encode(value);
  });
  const output = modelToolError(failure(`private ${secret}`), [], { secretMatcher: snapshot.matcher });
  assert.ok(!JSON.stringify(output).includes(secret));
  assert.ok(output.error.message.includes("[REDACTED:secret]"));
  assert.equal(derivations, 0);
});

test("legacy model-error forms keep one matcher for equal membership and refresh mutable arrays", t => {
  const first = randomUUID(), second = randomUUID(), next = randomUUID();
  // Hex is public to the generic token-pattern backstop, so only accidental raw-value derivation could mask it.
  const encoded = Buffer.from(first).toString("hex");
  const seen = new Set<SecretMatcher>();
  const mask = SecretMatcher.prototype.maskText;
  t.mock.method(SecretMatcher.prototype, "maskText", function (this: SecretMatcher, input: string): string {
    seen.add(this); return mask.call(this, input);
  });
  const forms = [first, second];
  for (let call = 0; call < 2; call++) {
    const output = modelToolError(failure(`${first} ${second} ${encoded}`), [], { secretForms: forms });
    assert.ok(!output.error.message.includes(first)); assert.ok(!output.error.message.includes(second));
    assert.ok(output.error.message.includes(encoded), "legacy forms are exact forms, not raw values to encode again");
    forms.reverse();
  }
  assert.equal(seen.size, 1, "equal legacy form membership reuses the compiled matcher");
  forms[0] = next;
  assert.ok(!modelToolError(failure(next), [], { secretForms: forms }).error.message.includes(next));
  assert.equal(seen.size, 2, "a mutable array cannot retain the previous membership generation");
});
