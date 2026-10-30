// `secretsOnly`: rule `secret` alone (exact registered values and their encodings), for text that is not a log line.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRedactor } from "../../src/logs/redact.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";

const fakeSecret = (label: string): string => `fixture-${label}-${createHash("sha256").update(label).digest("hex").slice(0, 16)}`;

describe("createRedactor({ secretsOnly })", () => {
  it("masks registered values and leaves everything the other rules would touch", () => {
    const secret = fakeSecret("only");
    const text = `k=${secret} password=hunter2 Bearer abc.def https://example.test/a?x=1 ${"A".repeat(60)}`;
    const only = createRedactor({ secrets: [secret], secretsOnly: true });
    assert.equal(only.text(text), text.replace(secret, "[REDACTED:secret]"));
    assert.notEqual(createRedactor({ secrets: [secret] }).text(text), only.text(text), "the full redactor still applies every rule");
  });

  it("keeps values under secret-looking keys and masks registered values in strings and keys", () => {
    const secret = fakeSecret("walk");
    const out = createRedactor({ secrets: [secret], secretsOnly: true }).value({ password: "hunter2", note: `x ${secret}`, [secret]: [1, secret, { token: "t" }] });
    assert.deepEqual(out, { password: "hunter2", note: "x [REDACTED:secret]", "[REDACTED:secret]": [1, "[REDACTED:secret]", { token: "t" }] });
  });

  it("applies the rule's minimum length (8) and leaves the default behaviour of createRedactor alone", () => {
    const short = "s".repeat(7);
    assert.equal(createRedactor({ secrets: [short], secretsOnly: true }).text(`a ${short}`), `a ${short}`);
    assert.equal(createRedactor({ secrets: ["e".repeat(8)], secretsOnly: true }).text("a eeeeeeee"), "a [REDACTED:secret]");
    assert.deepEqual(createRedactor().value({ password: "x", n: 1 }), { password: "[REDACTED:key]", n: 1 });
  });
});

describe("SecretRedaction.values()", () => {
  it("lists the values the registry masks: current ones and retired ones, nothing shorter than the minimum", () => {
    const registry = createSecretRedaction();
    const first = fakeSecret("one"), second = fakeSecret("two"), anonymous = fakeSecret("three");
    assert.deepEqual([...registry.values()], []);
    registry.register(first, "name");
    registry.register(anonymous);
    registry.register("short");
    registry.register(second, "name"); // rotates `first` out of the name; it stays masked as a retired value
    assert.deepEqual([...registry.values()].sort(), [first, second, anonymous].sort());
    for (const v of registry.values()) assert.ok(registry.contains(v));
  });
});
