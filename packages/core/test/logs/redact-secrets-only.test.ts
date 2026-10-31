// `secretsOnly`: rule `secret` alone (exact registered values and their encodings), for text that is not a log line.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRedactor, maskSecretsInJson, secretFormsIn } from "../../src/logs/redact.ts";
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

describe("secretFormsIn and the secretForms option", () => {
  it("derives each form once however many values share it and however often one is listed, longest first, skipping short values", () => {
    const a = fakeSecret("form-a"), b = fakeSecret("form-b");
    const once = secretFormsIn([a, b]);
    assert.deepEqual(secretFormsIn([a, b, a, a, "short", b]), once);
    assert.deepEqual(secretFormsIn(new Set([a, b])), once);
    assert.equal(new Set(once).size, once.length);
    assert.ok(once.includes(a) && once.includes(Buffer.from(b).toString("hex")));
    for (let i = 1; i < once.length; i++) assert.ok(once[i - 1]!.length >= once[i]!.length);
    assert.deepEqual(secretFormsIn(["short"]), []);
  });

  it("secretForms masks exactly the forms it is given, next to those derived from secrets", () => {
    const a = fakeSecret("given-a"), b = fakeSecret("given-b");
    const text = `${a} ${b}`;
    assert.equal(createRedactor({ secretForms: [a], secretsOnly: true }).text(text), `[REDACTED:secret] ${b}`);
    assert.equal(createRedactor({ secrets: [b], secretForms: [a], secretsOnly: true }).text(text), "[REDACTED:secret] [REDACTED:secret]");
  });
});

describe("maskSecretsInJson", () => {
  const awkward = `${fakeSecret("awk")}"\\\n\t é 😀`; // quote, backslash, control characters, non-ASCII, a surrogate pair

  it("returns undefined when no form occurs in the serialised text: nothing is walked, copied or cut", () => {
    let deep: unknown = { leaf: "plain" };
    for (let i = 0; i < 100; i++) deep = { next: deep };
    const json = JSON.stringify(deep);
    assert.equal(maskSecretsInJson(json, JSON.parse(json), [fakeSecret("absent"), awkward]), undefined);
    assert.equal(maskSecretsInJson(json, JSON.parse(json), []), undefined);
  });

  it("masks exactly what a full walk with every form masks, whatever JSON escapes (the scan is sound)", () => {
    const plain = fakeSecret("plain");
    const values: unknown[] = [
      { a: `x ${plain} y`, [plain]: 1 },
      { a: `before ${awkward} after`, b: [awkward, { [awkward]: awkward }] },
      [`${Buffer.from(plain).toString("base64")}`, Buffer.from(awkward).toString("hex"), encodeURIComponent(awkward)],
      { nested: { deeper: { deepest: [`${plain}${plain}`, `${awkward}${plain}`] } }, n: 7, t: true, z: null },
      { text: `😀${plain}😀`, lone: `${plain}\ud83d` },
    ];
    for (const value of values) {
      const json = JSON.stringify(value);
      const got = maskSecretsInJson(json, JSON.parse(json), [plain, awkward]);
      assert.ok(got, json);
      const want = createRedactor({ secrets: [plain, awkward], secretsOnly: true }).value(JSON.parse(json));
      assert.deepEqual(got.value, want, json);
      assert.equal(got.json, JSON.stringify(want));
    }
  });

  it("throws when a form that occurred is still there after masking (a number holds it), so the caller can withhold the result", () => {
    const pin = "4815162342";
    const json = JSON.stringify({ id: Number(pin), text: `pin ${pin}` });
    assert.throws(() => maskSecretsInJson(json, JSON.parse(json), [pin]), /outside any string/);
    const asText = JSON.stringify({ id: pin });
    assert.deepEqual(maskSecretsInJson(asText, JSON.parse(asText), [pin])?.value, { id: "[REDACTED:secret]" });
  });

  it("numbers keys that mask to the same text, in order, so none is lost", () => {
    const a = fakeSecret("nk-a"), b = fakeSecret("nk-b");
    const value = { [a]: 1, [b]: 2, other: 3, [Buffer.from(a).toString("hex")]: 4 };
    const json = JSON.stringify(value);
    assert.deepEqual(maskSecretsInJson(json, JSON.parse(json), [a, b])?.value, {
      "[REDACTED:secret]": 1, "[REDACTED:secret]#2": 2, other: 3, "[REDACTED:secret]#3": 4,
    });
  });
});
