// The framing boundary of the ACP server (P4-K K8): lines, chunks, bytes, JSON and the shape of a message, as a foreign process
// can get them wrong. Every scenario runs the real server; the Rust replay must write the same frames in the same order.
import { INIT, NEW, ev, ins, line, nf, rq, simple, type Scenario } from "./export-acp-support.ts";

const ok = (id: unknown = 1) => rq(id, "initialize", { protocolVersion: 1 });
/** A valid JSON-RPC line of exactly `bytes` bytes (without the line end): an unknown method with a padded string. */
function padded(bytes: number): string {
  const head = '{"jsonrpc":"2.0","id":1,"method":"nope","params":"';
  const tail = '"}';
  return head + "a".repeat(bytes - head.length - tail.length) + tail;
}
const hexOf = (s: string) => Buffer.from(s, "utf8").toString("hex");

export function buildFraming(): Scenario[] {
  const S = (name: string, events: unknown[], extra: Record<string, unknown> = {}): Scenario => ({ name, backend: simple(), events, ...extra });
  const small = { server: { maxLineBytes: 64 } };
  const out: Scenario[] = [];

  // --- lines and chunks
  out.push(S("plain-line", ins(ok())));
  out.push(S("crlf-line", ins(`${ok().trimEnd()}\r\n`)));
  out.push(S("empty-and-blank-lines", ins("\n\n\r\n", "   \n", "\t\r\n", ok())));
  out.push(S("half-frames-across-chunks", ins('{"jsonrpc":"2.0","id":1,"met', 'hod":"initialize","params":{"protocolVersion":1}}', "\n")));
  out.push(S("three-lines-one-chunk", ins(`${ok(1)}${ok(2)}${ok(3)}`)));
  out.push(S("no-final-newline-flushed-at-end", [ev.in(ok().trimEnd()), ev.end()]));
  out.push(S("no-final-newline-input-destroyed", [ev.in(ok().trimEnd()), ev.close()]));
  out.push(S("lone-carriage-return-at-end", [ev.in(`${ok().trimEnd()}\r`), ev.end()]));
  out.push(S("carriage-return-then-newline-in-next-chunk", ins(ok().trimEnd(), "\r", "\n")));
  out.push(S("double-carriage-return", ins(`${ok().trimEnd()}\r\r\n`)));
  out.push(S("unterminated-garbage-then-end", [ev.in("not json"), ev.end()]));
  out.push(S("end-without-any-input", [ev.end()]));
  out.push(S("input-error-event-keeps-serving", [ev.error(), ev.in(ok())]));
  out.push(S("input-destroyed-with-a-complete-line-before", [ev.in(ok()), ev.close()]));

  // --- the byte bound (64 here; the default one is 1 MiB, below)
  out.push(S("limit-exactly-the-bound", ins(`${padded(64)}\n`, ok(2)), small));
  out.push(S("limit-plus-one-byte", ins(`${padded(65)}\n`, ok(2)), small));
  out.push(S("limit-with-carriage-return", ins(`${padded(64)}\r\n`, ok(2)), small));
  out.push(S("limit-plus-one-with-carriage-return", ins(`${padded(65)}\r\n`, ok(2)), small));
  out.push(S("limit-plus-two-with-carriage-return", ins(`${padded(66)}\r\n`, ok(2)), small));
  out.push(S("overlong-line-then-a-good-one", ins(`${"x".repeat(100)}\n`, ok(2)), small));
  out.push(S("overlong-line-in-three-chunks", ins("x".repeat(40), "x".repeat(40), `x\n${ok(2)}`), small));
  out.push(S("overlong-line-never-ends", [ev.in("x".repeat(100)), ev.in("y".repeat(100)), ev.end()], small));
  out.push(S("overlong-line-ends-with-crlf-in-next-chunk", ins("x".repeat(100), `\r\n${ok(2)}`), small));
  out.push(S("many-overlong-lines", ins(...Array.from({ length: 20 }, () => `${"z".repeat(70)}\n`), ok(2)), small));
  out.push(S("bound-counts-bytes-not-characters", ins(`${'{"jsonrpc":"2.0","id":1,"method":"é","params":"' + "é".repeat(8)}"}\n`, `${'{"jsonrpc":"2.0","id":1,"method":"é","params":"' + "é".repeat(7)}"}\n`), small));
  const head = '{"jsonrpc":"2.0","id":1,"method":"nope","params":"';
  const MAX = 1024 * 1024;
  out.push(S("default-bound-exactly-1-mib", [{ repeat: { prefix: head, unit: "a", count: MAX - head.length - 2, suffix: '"}\n' } }, ev.in(ok(2))]));
  out.push(S("default-bound-one-byte-over", [{ repeat: { prefix: head, unit: "a", count: MAX - head.length - 1, suffix: '"}\n' } }, ev.in(ok(2))]));
  out.push(S("default-bound-far-over-in-one-chunk", [{ repeat: { unit: "x", count: 3 * MAX, suffix: "\n" } }, ev.in(ok(2))]));

  // --- bytes that are no UTF-8
  const j = (s: string) => hexOf(s);
  out.push(S("multibyte-split-across-chunks", [ev.hex(j('{"jsonrpc":"2.0","id":"') + "c3"), ev.hex("a9" + j('","method":"initialize","params":{"protocolVersion":1}}\n'))]));
  out.push(S("invalid-byte-in-a-string-reads-as-replacement", [ev.hex(j('{"jsonrpc":"2.0","id":"x') + "ff" + j('y","method":"initialize","params":{"protocolVersion":1}}\n'))]));
  out.push(S("invalid-byte-in-the-method", [ev.hex(j('{"jsonrpc":"2.0","id":1,"method":"ab') + "c0af" + j('"}\n'))]));
  out.push(S("truncated-sequence-at-the-end-of-a-line", [ev.hex(j('{"jsonrpc":"2.0","id":"a') + "e282" + j('","method":"initialize","params":{"protocolVersion":1}}\n'))]));
  out.push(S("lone-surrogate-bytes-are-three-replacements", [ev.hex(j('{"jsonrpc":"2.0","id":"') + "eda080" + j('","method":"initialize","params":{"protocolVersion":1}}\n'))]));
  out.push(S("overlong-encoding-of-slash", [ev.hex(j('{"jsonrpc":"2.0","id":"') + "c0af" + j('","method":"initialize","params":{"protocolVersion":1}}\n'))]));
  out.push(S("utf8-bom-before-the-object", [ev.hex("efbbbf" + j(ok()))]));
  out.push(S("line-separators-inside-a-string-are-no-line-break", [ev.in(`{"jsonrpc":"2.0","id":"a\u2028b\u2029c","method":"initialize","params":{"protocolVersion":1}}\n`)]));
  out.push(S("escaped-nul-in-an-id", [ev.in(`{"jsonrpc":"2.0","id":"a\\u0000b","method":"initialize","params":{"protocolVersion":1}}\n`)]));
  out.push(S("raw-control-character-in-a-string", [ev.hex(j('{"jsonrpc":"2.0","id":"a') + "01" + j('b","method":"initialize","params":{"protocolVersion":1}}\n'))]));
  out.push(S("astral-and-escaped-pair-ids", ins('{"jsonrpc":"2.0","id":"\\ud83d\\ude00😀","method":"initialize","params":{"protocolVersion":1}}\n')));

  // --- JSON that is not JSON
  const bad = ["{", "}", "[", "{\"jsonrpc\":\"2.0\",", "{'jsonrpc':'2.0'}", "{jsonrpc:\"2.0\"}", "{\"a\":1,}", "[1,]", "{\"a\" 1}", "{\"a\":01}",
    "{\"a\":+1}", "{\"a\":.5}", "{\"a\":1.}", "{\"a\":1e}", "{\"a\":NaN}", "{\"a\":Infinity}", "{\"a\":-}", "{\"a\":\"\\x\"}", "{\"a\":\"\\u12\"}",
    "{\"a\":tru}", "{\"a\":undefined}", "{} {}", "{}{}", "{} x", "//c\n{}", "{\"a\":1}//c", "\u00a0{}", "\u2028{}", "{\"a\":1\u00a0}", "{\"a\":\"b\"c}",
    "\"unterminated", "nul", "--1", "1 2", "0x10", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}}", "[{\"jsonrpc\":\"2.0\"}"];
  out.push(S("invalid-json-forms", ins(...bad.map((b) => `${b}\n`))));
  out.push(S("valid-json-that-is-no-object", ins("[]\n", "[1]\n", "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}]\n", "1\n", "-0\n", "1e400\n", "\"x\"\n", "null\n", "true\n", "false\n", "0\n")));
  out.push(S("objects-that-are-no-requests", ins("{}\n", '{"jsonrpc":"2.0"}\n', '{"jsonrpc":2.0}\n', '{"jsonrpc":2}\n', '{"jsonrpc":"2"}\n', '{"jsonrpc":"2.0 "}\n',
    '{"jsonrpc":["2.0"]}\n', '{"jsonrpc":null}\n', '{"JSONRPC":"2.0","id":1,"method":"initialize"}\n', '{"jsonrpc":"2.0","jsonrpc":"1.0","id":1,"method":"initialize"}\n',
    '{"jsonrpc":"1.0","jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')));
  out.push(S("duplicate-members-last-wins", ins('{"jsonrpc":"2.0","id":1,"id":2,"method":"initialize","params":{"protocolVersion":1}}\n', '{"jsonrpc":"2.0","id":3,"method":"x","method":"initialize","params":{"protocolVersion":1},"params":{"protocolVersion":2}}\n')));
  out.push(S("proto-and-constructor-members", ins('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"__proto__":{"x":1},"constructor":2}}\n', '{"__proto__":{"jsonrpc":"2.0"},"id":2,"method":"initialize"}\n', '{"jsonrpc":"2.0","id":3,"method":"toString"}\n', '{"jsonrpc":"2.0","id":4,"method":"__proto__"}\n', '{"jsonrpc":"2.0","id":5,"method":"constructor"}\n')));

  // --- ids
  const ids = ["true", "false", "{}", "[]", "[1]", "1.5", "1e400", "-1e400", "-0", "0", "\"\"", "12345678901234567890", "\"é\"", "1e21", "1e-7", "0.1", "5e-324", "null", "1E2", "100000000000000000000000", "-5", "9007199254740993"];
  out.push(S("id-forms", ins(...ids.map((i) => `{"jsonrpc":"2.0","id":${i},"method":"initialize","params":{"protocolVersion":1}}\n`))));
  out.push(S("id-forms-unknown-method", ins(...ids.map((i) => `{"jsonrpc":"2.0","id":${i},"method":"nope"}\n`))));
  out.push(S("duplicate-ids-are-both-answered", ins(ok(7), ok(7), rq(7, "nope"), rq("7", "nope"))));
  out.push(S("notification-forms-get-no-reply", ins('{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":1}}\n', '{"jsonrpc":"2.0","method":"nope"}\n', '{"jsonrpc":"2.0","method":"session/cancel"}\n',
    '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":5}}\n', '{"jsonrpc":"2.0","method":"session/cancel","params":[]}\n', '{"jsonrpc":"2.0","method":"$/cancel_request","params":{"id":1}}\n', '{"jsonrpc":"2.0","method":"MARKER-should-never-be-logged-0123456789"}\n')));

  // --- methods
  const methods = ["1", "null", "[]", "{}", "true", "\"\"", "\"Initialize\"", "\"initialize \"", "\"session/cancel\"", "\"session/load\"", "\"fs/read_text_file\"", "\"authenticate\"", "\"_app.plur1bus/steer\"", "\"session/set_mode\"", "\"session/new\"", "\"session/prompt\"", `"${"m".repeat(5000)}"`, "\"é\"", "\"MARKER-0123456789abcdef\""];
  out.push(S("method-forms-before-the-handshake", ins(...methods.map((m, i) => `{"jsonrpc":"2.0","id":${i + 1},"method":${m}}\n`))));
  out.push(S("method-forms-after-the-handshake", ins(INIT, ...methods.map((m, i) => `{"jsonrpc":"2.0","id":${i + 2},"method":${m}}\n`))));

  // --- answers to requests that were never made
  out.push(S("unsolicited-responses", ins(
    '{"jsonrpc":"2.0","id":"x","result":{}}\n', '{"jsonrpc":"2.0","id":"acp-permission-1","result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}\n',
    '{"jsonrpc":"2.0","id":5,"error":{"code":1,"message":"m"}}\n', '{"jsonrpc":"2.0","id":5,"result":1,"error":{}}\n', '{"jsonrpc":"2.0","id":5}\n',
    '{"jsonrpc":"2.0"}\n', '{"jsonrpc":"2.0","result":{}}\n', '{"jsonrpc":"2.0","id":null,"result":{}}\n', '{"jsonrpc":"2.0","id":[1],"result":{}}\n',
    '{"jsonrpc":"2.0","id":"a","method":5,"result":{}}\n', '{"jsonrpc":"2.0","id":"a","method":null,"result":{}}\n', '{"jsonrpc":"2.0","id":"a","method":null}\n', '{"jsonrpc":"2.0","id":"a","params":{}}\n')));

  // --- flood: many frames without a pause
  out.push(S("flood-of-invalid-json", [ev.in("{\n".repeat(300))]));
  out.push(S("flood-of-empty-objects", [ev.in("{}\n".repeat(2000))]));
  out.push(S("flood-of-unknown-methods", [ev.in(Array.from({ length: 300 }, (_, i) => rq(i, "nope")).join(""))]));
  out.push(S("flood-of-cancel-notifications", [ev.in(Array.from({ length: 500 }, (_, i) => nf("session/cancel", { sessionId: `s${i}` })).join(""))]));
  out.push(S("flood-mixes-immediate-and-awaited-replies", [ev.in(`${rq(1, "nope")}{\n${rq(2, "nope")}{}\n${ok(3)}[]\n${rq(4, "session/new", { cwd: "/w" })}x\n`)]));
  out.push(S("flood-in-one-byte-chunks", [...Array.from(`${ok(1)}{\n${rq(2, "nope")}`, (c) => ev.in(c))]));
  out.push(S("flood-of-overlong-lines-and-good-ones", ins(Array.from({ length: 100 }, (_, i) => (i % 2 ? `${"q".repeat(70)}\n` : ok(i))).join("")), small));

  // --- nesting and size of the value
  out.push(S("deep-nesting-in-params", [{ nest: { prefix: '{"jsonrpc":"2.0","id":1,"method":"nope","params":', depth: 20000, suffix: "}\n" } }, ev.in(ok(2))]));
  out.push(S("very-deep-nesting-in-params", [{ nest: { prefix: '{"jsonrpc":"2.0","id":1,"method":"nope","params":', depth: 500000, suffix: "}\n" } }, ev.in(ok(2))]));
  out.push(S("unclosed-deep-nesting", [{ repeat: { prefix: '{"jsonrpc":"2.0","id":1,"method":"nope","params":', unit: "[", count: 400000, suffix: "\n" } }, ev.in(ok(2))]));
  out.push(S("deep-nesting-as-the-whole-line", [{ nest: { prefix: "", depth: 500000, suffix: "\n" } }, ev.in(ok(2))]));
  out.push(S("many-distinct-members", [{ repeat: { prefix: '{"jsonrpc":"2.0","id":1,"method":"nope","params":{', unit: '"k":1,', count: 0, suffix: '"z":1}}\n' } }, ev.in(Array.from({ length: 3000 }, (_, i) => `"k${i}":1`).join(",").replace(/^/, '{"jsonrpc":"2.0","id":2,"method":"nope","params":{').concat("}}\n"))]));
  out.push(S("huge-string-in-a-valid-request", [{ repeat: { prefix: '{"jsonrpc":"2.0","id":1,"method":"nope","params":"', unit: "\\u00e9", count: 150000, suffix: '"}\n' } }, ev.in(ok(2))]));
  return out;
}
