import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMessage, toPlatformMarkdown, redactString, CallbackSigner, routeKey, RestLimiter } from "../src/index.ts";
import { FakeClock } from "./helpers/fake-clock.ts";

const Z = "​";

// ---- markdown conversion (table driven) ----
const mdCases: Array<[string, string, string]> = [
  ["bold stays native", "**bold** text", "**bold** text"],
  ["italic stays native", "*it* and _it_", "*it* and _it_"],
  ["inline code stays", "use `x <@123> y`", "use `x <@123> y`"],
  ["code block stays intact", "```ts\nconst a = '<@123> @everyone';\n```", "```ts\nconst a = '<@123> @everyone';\n```"],
  ["links stay", "[doc](https://example.test/a?b=1)", "[doc](https://example.test/a?b=1)"],
  ["autolink stays", "<https://example.test/x>", "<https://example.test/x>"],
  ["lists and quotes stay", "- a\n- b\n> quote\n1. one", "- a\n- b\n> quote\n1. one"],
  ["backslash escapes stay", "\\*not bold\\*", "\\*not bold\\*"],
  ["user mention neutralised", "hi <@123456789012345678>", `hi <${Z}@123456789012345678>`],
  ["nickname mention neutralised", "hi <@!123>", `hi <${Z}@!123>`],
  ["role mention neutralised", "<@&555>", `<${Z}@&555>`],
  ["channel mention neutralised", "see <#777>", `see <${Z}#777>`],
  ["slash command mention neutralised", "run </ban:123>", `run <${Z}/ban:123>`],
  ["@everyone neutralised", "@everyone wake up", `@${Z}everyone wake up`],
  ["@here neutralised", "ping @here now", `ping @${Z}here now`],
  ["plain html is not special", "<script>alert(1)</script>", "<script>alert(1)</script>"],
  ["unterminated fence protects to end", "a <@1>\n```\n<@2> @everyone", `a <${Z}@1>\n\`\`\`\n<@2> @everyone`],
  ["mention after closed code span is still neutralised", "`a` <@9>", `\`a\` <${Z}@9>`],
  ["CRLF normalised", "a\r\nb", "a\nb"],
  ["control chars stripped", "a\u0000b\u0007c", "abc"],
];
for (const [name, input, expected] of mdCases)
  test(`markdown: ${name}`, () => assert.equal(toPlatformMarkdown(input), expected));

test("markdown: idempotent", () => {
  const once = toPlatformMarkdown("<@1> @everyone `x` ```\n<@2>\n```");
  assert.equal(toPlatformMarkdown(once), once);
});

// ---- splitting ----
test("split: short text is one chunk", () => assert.deepEqual(splitMessage("hello"), ["hello"]));
test("split: chunks never exceed 2000", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(i % 40)}`).join("\n");
  const chunks = splitMessage(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 2000);
  assert.equal(chunks.join(""), text);
});
test("split: never tears a surrogate pair", () => {
  const text = "😀".repeat(30);
  for (const c of splitMessage(text, 17)) assert.ok(!/[\ud800-\udbff]$/.test(c) && !/^[\udc00-\udfff]/.test(c));
});
test("split: hard cut when there is no whitespace", () => {
  const chunks = splitMessage("a".repeat(4500));
  assert.deepEqual(chunks.map((c) => c.length), [2000, 2000, 500]);
});
test("split: code fences are closed and reopened with language", () => {
  const code = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const text = `intro\n\`\`\`ts\n${code}\n\`\`\`\noutro`;
  const chunks = splitMessage(text, 200);
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    assert.ok(c.length <= 200, `len ${c.length}`);
    assert.equal(c.split("\n").filter((l) => l.startsWith("```")).length % 2, 0, c);
  }
  assert.ok(chunks[1]!.startsWith("```ts\n"));
  const lines = chunks.flatMap((c) => c.split("\n").filter((l) => /^const v\d+ = \d+;$/.test(l)));
  assert.deepEqual(lines, code.split("\n"));
});
test("split: fence property over many sizes", () => {
  const text = "```js\n" + "abc def ghi\n".repeat(120) + "```\nafter text here\n";
  for (const max of [40, 57, 100, 333, 2000]) {
    const chunks = splitMessage(text, max);
    for (const c of chunks) {
      assert.ok(c.length <= max);
      assert.equal(c.split("\n").filter((l) => l.startsWith("```")).length % 2, 0);
    }
  }
});
test("split: whitespace-only chunks are dropped and bad max rejected", () => {
  assert.deepEqual(splitMessage("   "), []);
  assert.throws(() => splitMessage("x", 3), RangeError);
});

// ---- redaction ----
test("redact: exact token and token shapes and URL secrets", () => {
  const token = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GfAkE0", "FAKE_TOKEN_FOR_TESTS_ONLY_abcdef"].join(".");
  assert.equal(redactString(`oops ${token} x`, token), "oops [redacted] x");
  assert.ok(!redactString(`Bot ${["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GfAkE0"].join(".")}.abcdefghijklmnopqrstuvwxyz0`).includes("abcdefghij"));
  assert.equal(redactString("/interactions/123/SECRETTOKEN-abc_def/callback"), "/interactions/123/[redacted]/callback");
  assert.equal(redactString("/webhooks/9/SECRET.tok/messages/@original"), "/webhooks/9/[redacted]/messages/@original");
});

// ---- signer ----
test("signer: single use, chat bound, sender bound, ttl, forgery", () => {
  const clock = new FakeClock();
  const s = new CallbackSigner("k".repeat(32), clock.now);
  const wire = s.issue({ chatId: "c1", senders: ["u1"], data: "p|once", ttlMs: 1000 });
  assert.ok(wire.length <= 100);
  assert.deepEqual(s.consume(wire, "c2", "u1"), { ok: false, reason: "invalid" });
  assert.deepEqual(s.consume(wire, "c1", "u2"), { ok: false, reason: "forbidden" });
  assert.deepEqual(s.consume(wire, "c1", "u1"), { ok: true, data: "p|once" });
  assert.deepEqual(s.consume(wire, "c1", "u1"), { ok: false, reason: "invalid" });
  const w2 = s.issue({ chatId: "c1", senders: ["u1"], data: "x", ttlMs: 1000 });
  clock.t += 1001;
  assert.deepEqual(s.consume(w2, "c1", "u1"), { ok: false, reason: "expired" });
  const w3 = s.issue({ chatId: "c1", senders: ["u1"], data: "x", ttlMs: 1000 });
  assert.deepEqual(s.consume(w3.slice(0, -2) + "AA", "c1", "u1"), { ok: false, reason: "invalid" });
  assert.deepEqual(s.consume("garbage", "c1", "u1"), { ok: false, reason: "invalid" });
  assert.throws(() => s.issue({ chatId: "c", senders: ["u"], data: "x", ttlMs: 86_400_001 }), RangeError);
  assert.throws(() => s.issue({ chatId: "c", senders: [], data: "x", ttlMs: 10 }), RangeError);
});
test("signer: revokeWhere drops sibling handles", () => {
  const s = new CallbackSigner("k".repeat(32));
  const a = s.issue({ chatId: "c", senders: ["u"], data: "p1|a", ttlMs: 1000 });
  const b = s.issue({ chatId: "c", senders: ["u"], data: "p1|b", ttlMs: 1000 });
  s.revokeWhere((d) => d.startsWith("p1|"));
  assert.equal(s.consume(a, "c", "u").ok, false);
  assert.equal(s.consume(b, "c", "u").ok, false);
});

// ---- route keys ----
test("routeKey: masks ids except major parameters and tokens", () => {
  assert.equal(routeKey("PATCH", "/channels/123/messages/456"), "PATCH /channels/123/messages/:id");
  assert.equal(routeKey("POST", "/channels/123/typing"), "POST /channels/123/typing");
  assert.equal(routeKey("POST", "/interactions/77/tok/callback"), "POST /interactions/:id/:token/callback");
  assert.equal(routeKey("PATCH", "/webhooks/9/tok/messages/@original"), "PATCH /webhooks/9/:token/messages/@original");
  assert.equal(routeKey("PUT", "/applications/9/commands"), "PUT /applications/:id/commands");
});

// ---- limiter ----
test("limiter: waits for reset when remaining is zero, per bucket", async () => {
  const clock = new FakeClock();
  const l = new RestLimiter(clock.now, clock.sleep);
  const ac = new AbortController();
  const h = (remaining: string, resetAfter: string) =>
    new Headers({ "x-ratelimit-bucket": "b1", "x-ratelimit-remaining": remaining, "x-ratelimit-reset-after": resetAfter });
  await l.acquire("A", ac.signal, true);
  l.update("A", h("0", "2.5"));
  let done = false;
  const p = l.acquire("A", ac.signal, true).then(() => (done = true));
  await clock.flush();
  assert.equal(done, false);
  await l.acquire("B", ac.signal, true); // other route unaffected
  await clock.advance(2499);
  assert.equal(done, false);
  await clock.advance(2);
  await p;
  assert.equal(done, true);
});
test("limiter: global penalty blocks every authenticated route but not interaction routes", async () => {
  const clock = new FakeClock();
  const l = new RestLimiter(clock.now, clock.sleep);
  const ac = new AbortController();
  l.penalize("A", 3000, true);
  let a = false, b = false;
  void l.acquire("B", ac.signal, true).then(() => (a = true));
  void l.acquire("C", ac.signal, false).then(() => (b = true));
  await clock.flush();
  assert.deepEqual([a, b], [false, true]);
  await clock.advance(3000);
  assert.equal(a, true);
});
