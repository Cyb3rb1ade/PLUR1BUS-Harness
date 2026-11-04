import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSecretMatcher } from "../../src/logs/secret-matcher.ts";
import { SecretFormsCache } from "../../src/logs/secret-forms.ts";
import { createRedactor, maskSecretsInJson } from "../../src/logs/redact.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";

const MARK = "[REDACTED:secret]";

test("mixed raw and escaped overlaps use their complete original source union", () => {
  const value = randomUUID().replaceAll("-", "");
  const matcher = createSecretMatcher([value.slice(0, 8), value.slice(5, 13)]);
  const escaped = value.slice(0, 5) + "\\u" + value.charCodeAt(5).toString(16).padStart(4, "0") + value.slice(6, 13);
  const input = `before ${escaped} after`;
  assert.deepEqual(matcher.findTextSpans(input), [{ start: 7, end: 25 }]);
  assert.equal(matcher.maskText(input), `before ${MARK} after`);
  assert.equal(matcher.maskTextWindow(input, 9, 23), MARK);
});

test("source windows retain their original position after earlier matches shrink", () => {
  const secret = randomUUID(), matcher = createSecretMatcher([secret]);
  const input = `${secret} public ${secret} tail`;
  const begin = secret.length + 1;
  assert.equal(matcher.maskTextWindow(input, begin, begin + 6), "public");
  assert.equal(matcher.maskTextWindow(input, begin, input.length - 6), `public ${MARK}`);
  assert.equal(matcher.maskText(secret + secret), MARK + MARK);
});

test("an empty source window emits no marker even inside a registered value", () => {
  const secret = randomUUID(), matcher = createSecretMatcher([secret]);
  assert.equal(matcher.maskTextWindow(secret, 8, 8), "");
  assert.deepEqual(matcher.maskBytesWindow(Buffer.from(secret), 8, 8), Buffer.alloc(0));
});

test("byte windows mask before base64 while preserving arbitrary bytes outside matches", () => {
  const secret = `${randomUUID()}é😀`, matcher = new SecretFormsCache().snapshot([secret]).matcher;
  const before = Buffer.from([0xff, 0, 0xfe]), after = Buffer.from([0xf5, 0x80, 0]);
  const input = Buffer.concat([before, Buffer.from(secret), after]);
  assert.deepEqual(matcher.findByteSpans(input), [{ start: 3, end: input.length - 3 }]);
  assert.deepEqual(matcher.maskBytes(input), Buffer.concat([before, Buffer.from(MARK), after]));
  assert.deepEqual(matcher.maskBytesWindow(input, 7, input.length - 1), Buffer.concat([Buffer.from(MARK), after.subarray(0, 2)]));
  assert.equal(matcher.maskBytesWindow(input, 7, input.length - 1).toString("base64"), Buffer.concat([Buffer.from(MARK), after.subarray(0, 2)]).toString("base64"));
});

test("invalid UTF-8 does not invent a matching replacement character or change unrelated bytes", () => {
  const prefix = randomUUID(), suffix = randomUUID();
  const matcher = new SecretFormsCache().snapshot([prefix + "\ufffd" + suffix]).matcher;
  const input = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)]);
  assert.deepEqual(matcher.findByteSpans(input), []);
  assert.deepEqual(matcher.maskBytes(input), input);
});

test("byte padding covers fully escaped UTF-16 source spellings at either window edge", () => {
  const secret = `${randomUUID()}é😀`, matcher = new SecretFormsCache().snapshot([secret]).matcher;
  const escaped = Array.from({ length: secret.length }, (_, at) => "\\u" + secret.charCodeAt(at).toString(16).padStart(4, "0")).join("");
  const bytes = Buffer.from(escaped);
  assert.ok(matcher.maxSourceBytes >= bytes.length);
  assert.deepEqual(matcher.findByteSpans(bytes), [{ start: 0, end: bytes.length }]);
  assert.equal(matcher.maskBytesWindow(bytes, 3, bytes.length - 2).toString(), MARK);
  assert.equal(matcher.maskTextWindow(escaped, 3, escaped.length - 2), MARK);
});

test("compiled JSON scanning resets between tokens and retains original-hit residual semantics", () => {
  const secret = randomUUID(), matcher = createSecretMatcher([secret, "REDACTED"]);
  const split = [secret.slice(0, 20), secret.slice(20)];
  assert.equal(matcher.scanJson(JSON.stringify(split)).found, false);
  const value = { ordinary: secret };
  assert.deepEqual(maskSecretsInJson(JSON.stringify(value), value, [], { forms: matcher.forms, matcher })?.value, { ordinary: MARK });
  const both = { ordinary: secret, other: "REDACTED" };
  assert.throws(() => maskSecretsInJson(JSON.stringify(both), both, [], { forms: matcher.forms, matcher }), /outside any string/);
});

test("one compiled generation follows membership rather than iterable identity, order, or pin changes", () => {
  const values = [randomUUID(), randomUUID()], cache = new SecretFormsCache();
  const first = cache.snapshot(values);
  assert.equal(cache.snapshot([...values].reverse()), first);
  values.push(randomUUID());
  const second = cache.snapshot(values);
  assert.notEqual(second.matcher, first.matcher);
  assert.equal(cache.snapshot(values), second);
  assert.equal(createRedactor({ secretMatcher: second.matcher, secretsOnly: true }).text(values[2]!), MARK);
  const registry = createSecretRedaction(); registry.register(values[0]!, "first");
  const original = registry.snapshot(); registry.register(values[0]!, "second");
  assert.equal(registry.snapshot(), original);
  assert.equal(registry.redactor().secretMatcher!(), original.matcher);
});

test("masking a surrogate half conceals its whole code point without creating another registered spelling", () => {
  const publicPrefix = randomUUID(), secret = randomUUID() + "\ud83d";
  const formed = publicPrefix + MARK + "\ufffd";
  const redactor = createRedactor({ secretForms: [secret, formed], secretsOnly: true });
  assert.equal(redactor.text(publicPrefix + secret + "\ude00"), publicPrefix + MARK);
});

test("source spans include complete surrogate pairs and prevent a three-stage replacement cascade", () => {
  const first = randomUUID(), middle = randomUUID(), last = randomUUID(), tail = ` public ${randomUUID()}`;
  const matcher = createSecretMatcher([first + "\ud83d", "\ufffd" + middle + "\ud83d", "\ufffd" + last]);
  const source = first + "😀" + middle + "😀" + last + tail;
  assert.deepEqual(matcher.findTextSpans(source), [{ start: 0, end: first.length + 2 }]);
  assert.deepEqual(matcher.projectText(source), {
    text: MARK + middle + "😀" + last + tail, spans: [{ start: 0, end: first.length + 2 }],
  });
  assert.equal(matcher.maskText(source), MARK + middle + "😀" + last + tail);
  assert.equal(matcher.maskTextWindow(source, first.length + 2, source.length), middle + "😀" + last + tail);
});

for (const [name, pair] of [["raw", "😀"], ["escaped", "\\ud83d\\ude00"], ["raw-high", "\ud83d\\ude00"], ["raw-low", "\\ud83d\ude00"]])
  test(`matching a surrogate half covers its entire ${name} source spelling`, () => {
    const prefix = randomUUID(), suffix = randomUUID();
    const matcher = createSecretMatcher([prefix + "\ud83d"]);
    const source = prefix + pair + suffix;
    assert.deepEqual(matcher.findTextSpans(source), [{ start: 0, end: prefix.length + pair!.length }]);
    assert.equal(matcher.maskText(source), MARK + suffix);
    assert.equal(matcher.maskTextWindow(source, prefix.length, prefix.length + 1), MARK);
  });

test("pair expansion at both edges remains inside the declared escaped-source padding", () => {
  const middle = randomUUID(), matcher = createSecretMatcher(["\ude00" + middle + "\ud83d"]);
  const escaped = "\\ud83d\\ude00" + Array.from(middle, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "\\ud83d\\ude00";
  assert.deepEqual(matcher.findTextSpans(escaped), [{ start: 0, end: escaped.length }]);
  assert.deepEqual(matcher.findByteSpans(Buffer.from(escaped)), [{ start: 0, end: escaped.length }]);
  assert.ok(matcher.maxSourceBytes >= Buffer.byteLength(escaped));
});

test("public source-window edges omit incomplete code points instead of inventing a registered replacement spelling", () => {
  const publicText = randomUUID();
  const matcher = createSecretMatcher(["\ufffd" + publicText, publicText + "\ufffd"]);
  assert.equal(matcher.maskTextWindow("😀" + publicText, 1, publicText.length + 2), publicText);
  assert.equal(matcher.maskTextWindow(publicText + "😀", 0, publicText.length + 1), publicText);
});
