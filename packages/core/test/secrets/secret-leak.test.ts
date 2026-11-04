// SH3 canaries are generated at run time; only exact-value redaction can satisfy these probes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { LIMITS } from "@plur1bus/log-schema";
import { createRedactor, maskSecretsInJson } from "../../src/logs/redact.ts";
import { OutputLines } from "../../src/logs/output.ts";
import { createWriter } from "../../src/logs/writer.ts";
import type { LogWriter } from "../../src/logs/writer.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { capResult } from "../../src/toolcall/results.ts";
import { dispatcherProbe } from "./fixtures/dispatcher.ts";

const MARK = "[REDACTED:secret]";
const unicode = (char: string): string => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");

test("self-overlapping registered values conceal their complete source union", () => {
  const unit = randomUUID().slice(0, 2);
  const secret = unit.repeat(4);
  const text = `before ${unit.repeat(5)} after`;
  assert.equal(createRedactor({ secrets: [secret], secretsOnly: true }).text(text), `before ${MARK} after`);
});

test("process output prepares its text once and retains writer PII protection", () => {
  const dir = tempDir("p1b-output-once-");
  const canary = randomUUID(); let preparations = 0;
  const policy = createRedactor({ pii: true });
  const redactor = {
    text(text: string) { if (text.includes(canary)) preparations++; return policy.text(text); },
    value<T>(value: T): T {
      if (value && typeof value === "object" && "text" in value && String(value.text).includes(canary)) preparations++;
      return policy.value(value);
    },
  };
  const writer = createWriter({ dir, role: "core.out", timers: false, redactor,
    source: { kind: "harness", id: "exec", version: "0.1.0" } });
  const output = new OutputLines(writer, "stdout");
  output.push(Buffer.from(`${canary} contact user@example.com\n`)); output.close(); writer.close();
  const rows = readdirSync(dir).filter(name => name.endsWith(".log")).flatMap(name => readFileSync(join(dir, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  assert.equal(preparations, 1);
  assert.equal(rows.filter(row => row.event === "process.output.line").length, 1);
  assert.ok(JSON.stringify(rows).includes("[REDACTED:pii]"));
  assert.ok(!JSON.stringify(rows).includes("user@example.com"));
});

test("idle process framing retains a possible registered-secret suffix", () => {
  const secret = `${randomUUID()}:${randomUUID()}`;
  let now = 0; const seen: string[] = [];
  const writer = { write: (_event: string, attrs: { text: string }) => { if (attrs.text) seen.push(attrs.text); } } as unknown as LogWriter;
  const output = new OutputLines(writer, "stdout", { secrets: [secret], now: () => now });
  const split = 22;
  output.push(Buffer.from(`public ${secret.slice(0, split)}`)); now = 1001; output.tick();
  assert.ok(!seen.join("\n").includes(secret.slice(0, split)), "idle flush exposed a registered prefix");
  output.push(Buffer.from(`${secret.slice(split)}\n`)); output.close();
  assert.ok(seen.join("\n").includes(MARK));
  assert.ok(!seen.join("\n").includes(secret.slice(split)));
});

test("idle framing preserves UTF-8 decoder carry inside a registered value", () => {
  const secret = `${randomUUID()}€${randomUUID()}`, bytes = Buffer.from(secret);
  const split = Buffer.byteLength(secret.slice(0, secret.indexOf("€"))) + 2;
  let now = 0; const seen: string[] = [];
  const writer = { write: (_event: string, attrs: { text: string }) => { if (attrs.text) seen.push(attrs.text); } } as unknown as LogWriter;
  const output = new OutputLines(writer, "stdout", { secrets: [secret], now: () => now });
  output.push(bytes.subarray(0, split)); now = 2000; output.tick();
  output.push(Buffer.concat([bytes.subarray(split), Buffer.from("\n")])); output.close();
  assert.deepEqual(seen, [MARK]);
});

test("output sanitisation cannot join a registered value after the only preparation", () => {
  const secret = randomUUID(), dir = tempDir("p1b-output-sanitise-");
  const registry = createSecretRedaction(); registry.register(secret, "sanitised");
  const writer = createWriter({ dir, role: "core.out", timers: false, redactor: registry.redactor(),
    source: { kind: "harness", id: "exec", version: "0.1.0" } });
  const output = new OutputLines(writer, "stdout");
  output.push(Buffer.from(secret.slice(0, 20) + "\x1b[31m" + secret.slice(20) + "\n")); output.close(); writer.close();
  const text = readdirSync(dir).filter(name => name.endsWith(".log")).map(name => readFileSync(join(dir, name), "utf8")).join("\n");
  assert.ok(text.includes(MARK)); assert.ok(!text.includes(secret));
});

for (const oversized of [false, true]) test(`registered newline-containing output stays private${oversized ? " across a discarded oversized frame" : ""}`, () => {
  const dir = tempDir("p1b-output-newline-");
  const first = randomUUID(), last = randomUUID();
  const secret = `${first}\n${oversized ? "middle ".repeat(11000) + "\n" : ""}${last}`;
  const registry = createSecretRedaction(); registry.register(secret, "multiline");
  const writer = createWriter({ dir, role: "core.out", timers: false, redactor: registry.redactor(),
    source: { kind: "harness", id: "exec", version: "0.1.0" } });
  const output = new OutputLines(writer, "stdout");
  output.push(Buffer.from(secret + "\n")); output.close(); writer.close();
  const text = readdirSync(dir).filter(name => name.endsWith(".log")).map(name => readFileSync(join(dir, name), "utf8")).join("\n");
  assert.ok(!text.includes(first), "newline framing exposed the first secret component");
  assert.ok(!text.includes(last), "newline framing exposed the last secret component");
  assert.ok(text.includes(oversized ? "[TRUNCATED:oversized-line]" : MARK));
});

for (const shape of ["canonical", "slash", "go", "mixed-unicode"] as const)
  test(`registered values remain private in nested JSON text: ${shape}`, async () => {
    const secret = `${randomUUID()}:"\\/<>&é`;
    const canonical = JSON.stringify(secret).slice(1, -1);
    const encoded = shape === "canonical" ? canonical : shape === "slash" ? canonical.replaceAll("/", "\\/")
      : shape === "go" ? canonical.replace(/[<>&]/g, unicode)
        : Array.from(secret, (char, index) => index % 3 === 0 ? unicode(char) : JSON.stringify(char).slice(1, -1)).join("");
    const text = `before ${encoded} after`;
    assert.equal(createRedactor({ secrets: [secret], secretsOnly: true }).text(text), `before ${MARK} after`);
    const value = { ordinary: text };
    const masked = maskSecretsInJson(JSON.stringify(value), value, [secret]);
    assert.deepEqual(masked?.value, { ordinary: `before ${MARK} after` });
    const result = await dispatcherProbe(async () => value, () => [secret]).run();
    assert.equal(result.isError, false);
    assert.deepEqual(result.isError ? undefined : result.value, { ordinary: `before ${MARK} after` });
  });

test("the bounded process-output window cannot expose a registered prefix at its visible cut", () => {
  const piece = randomUUID().slice(0, 8) + ".";
  const secret = piece.repeat(1600);
  const prefix = "public ".repeat(LIMITS.lineBytes).slice(0, LIMITS.lineBytes - 32);
  const seen: string[] = [];
  const writer = { write: (_event: string, attrs: { text: string }) => { seen.push(attrs.text); } } as unknown as LogWriter;
  const output = new OutputLines(writer, "stdout", { secrets: [secret] });
  output.push(Buffer.from(prefix + secret + "\n")); output.close();
  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.includes(piece.repeat(2)), "the visible prefix survived the internal redaction-window cut");
  assert.ok(seen[0]!.includes(MARK));
});

test("framing preserves public URL prefixes and values below the exact-value minimum", () => {
  const base = "https://endpoint.example/visible/path";
  const short = randomUUID().slice(0, 7);
  const seen: string[] = [];
  const writer = { write: (_event: string, attrs: { text: string }) => { seen.push(attrs.text); } } as unknown as LogWriter;
  const output = new OutputLines(writer, "stdout", { secrets: [`${base}/${randomUUID()}`, short] });
  output.push(Buffer.from(`${base} ordinary ${short}\n`)); output.close();
  assert.deepEqual(seen, [`${base} ordinary ${short}`]);
});

test("masking part of a surrogate pair cannot leave an unmatched surrogate behind", () => {
  const prefix = randomUUID();
  const text = createRedactor({ secretForms: [prefix + "\ud83d"], secretsOnly: true }).text(prefix + "😀");
  assert.ok(text.isWellFormed());
  assert.ok(!text.includes(prefix));
});

test("production process framing masks live registry and writer-only values before the visible cut", () => {
  const dir = tempDir("p1b-output-registry-");
  const registry = createSecretRedaction();
  const writer = createWriter({ dir, role: "core.out", timers: false, redactor: registry.redactor(),
    source: { kind: "harness", id: "exec", version: "0.1.0" } });
  const output = new OutputLines(writer, "stdout");
  const prefix = "public ".repeat(16);
  const pieces = Array.from({ length: 2 }, () => randomUUID().slice(0, 8) + ".");
  const values = pieces.map(piece => piece.repeat(1600));
  // Both policies change after the framer is constructed, as they can during a real Core run.
  registry.register(values[0]!, "later");
  writer.registerSecret(values[1]!, { pinned: true });
  try {
    for (const value of values) output.push(Buffer.from(prefix + value + "\n"));
    output.close(); writer.close();
    const text = readdirSync(dir).filter(name => name.endsWith(".log"))
      .map(name => readFileSync(join(dir, name), "utf8")).join("\n");
    for (const piece of pieces) assert.ok(!text.includes(piece.repeat(2)), "a live-policy prefix survived the visible cut");
    assert.ok(text.includes(MARK));
  } finally { writer.close(); }
});

test("a failed writer policy withholds process output without throwing into child-stream handling", () => {
  const dir = tempDir("p1b-output-failed-policy-");
  const redactor = { text(): string { throw new Error("fixture policy unavailable"); }, value<T>(_value: T): T { throw new Error("fixture policy unavailable"); } };
  const writer = createWriter({ dir, role: "core.out", timers: false, redactor,
    source: { kind: "harness", id: "exec", version: "0.1.0" } });
  const output = new OutputLines(writer, "stdout");
  const line = randomUUID();
  try {
    assert.doesNotThrow(() => { output.push(Buffer.from(line + "\n")); output.close(); writer.close(); });
    const text = readdirSync(dir).filter(name => name.endsWith(".log"))
      .map(name => readFileSync(join(dir, name), "utf8")).join("\n");
    assert.ok(!text.includes(line));
    assert.ok(text.includes("log.redaction.failed"));
  } finally { writer.close(); }
});

test("an unmatched surrogate in a registered value cannot poison shared forms or unrelated deep results", async () => {
  const secret = randomUUID() + "\ud800";
  const registry = createSecretRedaction(); registry.register(secret, "fixture");
  assert.doesNotThrow(() => registry.forms());
  const redactor = registry.redactor({ secretsOnly: true });
  for (const text of [secret, secret.toWellFormed(), JSON.stringify(secret).slice(1, -1)]) {
    assert.equal(redactor.text(text), MARK);
  }
  const paired = await dispatcherProbe(async () => ({ ordinary: secret + "\udc00" }), () => registry.values(), {}, () => registry.forms()).run();
  assert.equal(paired.isError, false);
  assert.deepEqual(paired.isError ? undefined : paired.value, { ordinary: MARK });
  assert.deepEqual(registry.snapshot().matcher.projectText(secret + "\udc00"), {
    text: MARK, spans: [{ start: 0, end: secret.length + 1 }],
  });
  let value: unknown = { ordinary: "public detail" };
  for (let i = 0; i < 100; i++) value = { next: value };
  const result = await dispatcherProbe(async () => value, () => registry.values(), {}, () => registry.forms()).run();
  assert.equal(result.isError, false);
  assert.deepEqual(result.isError ? undefined : result.value, value);
});

for (const [shape, suffix] of [["quote", '"\ud800'], ["internal-lone", '\ud800X\ud800']]) test(`mixed escaped text and a surrogate-pair boundary cannot evade the JSON prescan: ${shape}`, async () => {
  const secret = randomUUID() + suffix;
  const registry = createSecretRedaction(); registry.register(secret, "fixture");
  const result = await dispatcherProbe(async () => ({ ordinary: secret + "\udc00" }), () => registry.values(), {}, () => registry.forms()).run();
  assert.equal(result.isError, false);
  assert.deepEqual(result.isError ? undefined : result.value, { ordinary: MARK });
  assert.deepEqual(registry.snapshot().matcher.projectText(secret + "\udc00"), {
    text: MARK, spans: [{ start: 0, end: secret.length + 1 }],
  });
});

test("well-forming output cannot create an unmasked UTF-8 spelling of a known value", async () => {
  const prefix = randomUUID(), registry = createSecretRedaction();
  registry.register(prefix + "\ud800", "fixture");
  const text = prefix + "\ud801"; // Distinct UTF-16 input, identical bytes when encoded as UTF-8.
  assert.equal(registry.redactor({ secretsOnly: true }).text(text), MARK);
  const result = await dispatcherProbe(async () => ({ ordinary: text }), () => registry.values(), {}, () => registry.forms()).run();
  assert.equal(result.isError, false);
  assert.deepEqual(result.isError ? undefined : result.value, { ordinary: MARK });
  const escaped = prefix + "\\ud801";
  assert.equal(registry.redactor({ secretsOnly: true }).text(escaped), MARK);
  const nested = await dispatcherProbe(async () => ({ ordinary: escaped }), () => registry.values(), {}, () => registry.forms()).run();
  assert.equal(nested.isError, false);
  assert.deepEqual(nested.isError ? undefined : nested.value, { ordinary: MARK });
});

test("JSON string spellings preserve privacy across quote, slash and unmatched-surrogate positions", async () => {
  const prefix = randomUUID();
  for (const secret of [prefix + '\ud800', prefix + '"\ud800', prefix + '\ud800X\ud800', '\ud800' + prefix,
    prefix + '\\/\ud800', prefix + '<>&é']) {
    for (const value of [secret, secret + '\udc00', secret.toWellFormed()]) {
      const canonical = JSON.stringify(value).slice(1, -1);
      const spellings = [value, canonical, canonical.replaceAll('/', '\\/'),
        Array.from({ length: value.length }, (_, i) => unicode(value[i]!)).join('')];
      for (const text of spellings) {
        const direct = createRedactor({ secrets: [secret], secretsOnly: true }).text(text);
        assert.ok(!direct.includes(prefix), 'text boundary retained the known prefix');
        const result = await dispatcherProbe(async () => ({ ordinary: text }), () => [secret]).run();
        assert.equal(result.isError, false, 'a supported string spelling must remain a structured result');
        assert.ok(!JSON.stringify(result).includes(prefix), 'JSON boundary retained the known prefix');
      }
    }
  }
});

test("dispatcher and capped error hints keep emoji boundaries well formed", async () => {
  const failure = await dispatcherProbe(async () => { throw new Error("m".repeat(498) + "😀 trailing"); }, () => []).run();
  assert.ok(failure.isError);
  assert.ok(failure.error.message.isWellFormed());
  const capped = await capResult({ isError: true, error: { code: "tool-failed", hint: "h".repeat(79) + "😀 trailing" } },
    { async put() { throw new Error("an ordinary error hint must fit"); } });
  assert.ok(capped.error!.hint.isWellFormed());
});

test("variants are derived once per unchanged dispatcher secret set and change with mutable source membership", async t => {
  const first = randomUUID(), second = randomUUID();
  const known = [first]; let body = first; let derived = 0;
  const original = Buffer.from;
  t.mock.method(Buffer, "from", (...args: unknown[]) => {
    if (args[0] === first || args[0] === second) derived++;
    return Reflect.apply(original, Buffer, args) as ReturnType<typeof Buffer.from>;
  });
  const probe = dispatcherProbe(async () => ({ ordinary: body }), () => known);
  for (let i = 0; i < 3; i++) {
    const result = await probe.run();
    assert.equal(result.isError, false);
    assert.deepEqual(result.isError ? undefined : result.value, { ordinary: MARK });
  }
  assert.equal(derived, 1, "steady-state calls repeated variant derivation");
  known[0] = second; body = second;
  const changed = await probe.run();
  assert.deepEqual(changed.isError ? undefined : changed.value, { ordinary: MARK });
  assert.equal(derived, 2);
});

test("a registered JSON-looking value does not reinterpret public JSON structure as a secret string", () => {
  const label = randomUUID();
  const secret = JSON.stringify([label]);
  const value = { ordinary: [label] };
  assert.equal(maskSecretsInJson(JSON.stringify(value), value, [secret]), undefined);
});
